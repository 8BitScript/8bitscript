// AST node shapes.
//
// Every node carries `start` and `length`, the same span a diagnostic uses.
// That is not incidental: positions recorded at parse time are what let a
// checker error land on the exact characters that caused it, in the terminal
// and under the cursor, without anything downstream re-deriving a location.
//
// Nodes are plain objects. There is no class hierarchy and no visitor
// framework: a `type` string and a switch is enough at this size, and it keeps
// the tree trivially serialisable for tests.

export const NodeType = {
  Program: 'Program',

  ImportDeclaration: 'ImportDeclaration',
  VariableDeclaration: 'VariableDeclaration',
  FunctionDeclaration: 'FunctionDeclaration',
  NamespaceDeclaration: 'NamespaceDeclaration',
  Parameter: 'Parameter',

  BlockStatement: 'BlockStatement',
  IfStatement: 'IfStatement',
  WhileStatement: 'WhileStatement',
  ForStatement: 'ForStatement',
  ReturnStatement: 'ReturnStatement',
  BreakStatement: 'BreakStatement',
  ContinueStatement: 'ContinueStatement',
  ExpressionStatement: 'ExpressionStatement',
  AsmBlock: 'AsmBlock',

  Identifier: 'Identifier',
  IntegerLiteral: 'IntegerLiteral',
  // A decimal fraction (`0.5`) — legal only as the sole argument to the
  // `seconds(...)` compile-time duration builtin (packages/compiler/src/
  // fold), which consumes and removes every valid one before anything else
  // sees the tree; one surviving to `check()` means it was used somewhere
  // else, which is always a diagnostic (the language has no other float
  // semantics).
  DecimalLiteral: 'DecimalLiteral',
  BooleanLiteral: 'BooleanLiteral',
  StringLiteral: 'StringLiteral',

  AssignmentExpression: 'AssignmentExpression',
  BinaryExpression: 'BinaryExpression',
  UnaryExpression: 'UnaryExpression',
  UpdateExpression: 'UpdateExpression',
  CallExpression: 'CallExpression',
  MemberExpression: 'MemberExpression',
  IndexExpression: 'IndexExpression',

  TypeReference: 'TypeReference',
  Decorator: 'Decorator',
};

/** Build a node with its span. */
export function node(type, start, end, props = {}) {
  return { type, start, length: end - start, ...props };
}

/**
 * Walk every node in a tree, parents before children.
 *
 * @param {object} root
 * @param {(node: object, parent: object|null) => void} visit
 */
export function walk(root, visit, parent = null) {
  if (!root || typeof root.type !== 'string') return;
  visit(root, parent);
  for (const value of Object.values(root)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit, root);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walk(value, visit, root);
    }
  }
}
