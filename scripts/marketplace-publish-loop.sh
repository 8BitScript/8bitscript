#!/usr/bin/env bash
# The retry loop for the Visual Studio Marketplace publish in release.yml.
# Kept in a script so scripts/marketplace-publish-loop.test.mjs can run the
# real code against stub `az`, `curl` and `node`.
#
# Sign-in per attempt: the first attempt reads the access token from the
# azure/login step. `az account get-access-token` returns that cached token
# until it is close to expiry (about an hour), and cannot renew it once the
# GitHub OIDC assertion behind it has expired, so every later attempt first
# requests a new GitHub OIDC token and signs in again. If any part of that
# fails (get_token is then not called, since az would return its stale
# cached token), or the token is not one non-empty line, the attempt uses VSCE_PAT
# when it is set.
#
# Never capture output with $(...) around anything that prints an
# ::add-mask:: line: the runner would not see it and the capture would hold
# it. `token` is a global set by get_token, and the mask is printed only
# after the value is checked, before it can be used or logged.
set -u

vsix=${1:?usage: marketplace-publish-loop.sh <file.vsix>}
max=${MAX_ATTEMPTS:-6}
delay=${RETRY_DELAY:-60}
resource=499b84ac-1321-427f-aa17-267ca6975798

token=""

relogin() {
  local jwt
  jwt=$(curl -sSf -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL:-}&audience=api://AzureADTokenExchange" |
    sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p') || return 1
  [ -n "$jwt" ] || return 1
  echo "::add-mask::$jwt"
  az login --service-principal -u "${AZURE_CLIENT_ID:-}" --tenant "${AZURE_TENANT_ID:-}" \
    --federated-token "$jwt" --allow-no-subscriptions --output none
}

get_token() {
  local raw
  token=""
  raw=$(az account get-access-token --resource "$resource" --query accessToken -o tsv) || return 1
  case "$raw" in
    '' | *$'\n'* | *$'\r'*) return 1 ;;
  esac
  echo "::add-mask::$raw"
  token=$raw
}

for attempt in $(seq 1 "$max"); do
  token=""
  if [ "${AZURE_LOGIN_OUTCOME:-}" = success ]; then
    # A failed sign-in must not fall through to get_token: az would hand
    # back the stale cached token. The attempt goes straight to the PAT.
    signed_in=1
    if [ "$attempt" -gt 1 ]; then
      relogin || {
        signed_in=0
        echo "Azure sign-in again failed on attempt $attempt."
      }
    fi
    if [ "$signed_in" = 1 ]; then
      get_token || token=""
    fi
    if [ -z "$token" ]; then
      if [ -n "${VSCE_PAT:-}" ]; then
        echo "No usable Entra token; using VSCE_PAT for this attempt."
      else
        echo "No usable Entra token and VSCE_PAT is not set."
      fi
    fi
  else
    echo "Azure sign-in unavailable; using VSCE_PAT."
  fi
  if [ -n "$token" ]; then
    VSCE_AAD_TOKEN="$token" node scripts/publish-marketplace.mjs "$vsix" && exit 0
  elif [ -n "${VSCE_PAT:-}" ]; then
    node scripts/publish-marketplace.mjs "$vsix" && exit 0
  fi
  [ "$attempt" = "$max" ] && exit 1
  echo "Marketplace publish failed (attempt $attempt/$max), retrying in ${delay}s..."
  sleep "$delay"
done
