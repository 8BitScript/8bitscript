use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A field that may be absent, `null`, or a value (rulebook R3.4).
///
/// Use with `#[serde(default, skip_serializing_if = "Nullable::is_absent")]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Nullable<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Nullable<T> {
    #[must_use]
    pub fn is_absent(&self) -> bool {
        matches!(self, Nullable::Absent)
    }

    /// JS truthiness for the "has a value" test: `Absent` and `Null` are false.
    #[must_use]
    pub fn is_value(&self) -> bool {
        matches!(self, Nullable::Value(_))
    }

    #[must_use]
    pub fn as_option(&self) -> Option<&T> {
        match self {
            Nullable::Value(v) => Some(v),
            _ => None,
        }
    }
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Nullable::Value(v) => serializer.serialize_some(v),
            _ => serializer.serialize_none(),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(v) => Nullable::Value(v),
            None => Nullable::Null,
        })
    }
}
