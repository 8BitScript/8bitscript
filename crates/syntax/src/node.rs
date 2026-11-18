//! AST nodes (`ast/index.mjs`). A node serializes to `{type, start, length,
//! ...props}` with the parser's prop names (R6.2). The variant list is the
//! JS `NodeType` list; fields follow the parser's `node(...)` calls.
//!
//! Field types follow R3: a child the parser can leave `null` after error
//! recovery is `Option<Box<Node>>` written as `null` (R3.3); a prop the
//! parser sets only sometimes is `Option<T>` and skipped when absent (R3.2).

use serde::{Deserialize, Serialize};

/// Identity of a node inside one module (R1.5). Not part of the dump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub struct NodeId(pub u32);

/// One AST node. `start` and `length` are UTF-16 code units (R6.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    #[serde(skip)]
    pub id: NodeId,
    pub start: u32,
    pub length: u32,
    /// Assigned after construction by the parser (`parser/index.mjs:464`),
    /// so it is visited last by the walker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decorators: Option<Vec<Node>>,
    #[serde(flatten)]
    pub kind: NodeKind,
}

impl Node {
    /// `node(type, start, end, props)` from the JS: a node with no id yet and
    /// no decorators.
    #[must_use]
    pub fn new(start: u32, end: u32, kind: NodeKind) -> Self {
        Self {
            id: NodeId::default(),
            start,
            length: end.saturating_sub(start),
            decorators: None,
            kind,
        }
    }

    /// The JS `type` string of this node.
    #[must_use]
    pub fn type_name(&self) -> &'static str {
        self.kind.type_name()
    }
}

/// `NodeType` and the props each type carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum NodeKind {
    Program {
        body: Vec<Node>,
    },

    ImportDeclaration {
        specifiers: Vec<Node>,
        #[serde(default)]
        source: Option<Box<Node>>,
        /// New syntax only: the source is a path form the resolver searches.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        use_path: Option<bool>,
    },
    VariableDeclaration {
        kind: String,
        #[serde(default)]
        name: Option<Box<Node>>,
        #[serde(default)]
        type_annotation: Option<Box<Node>>,
        #[serde(default)]
        initializer: Option<Box<Node>>,
        exported: bool,
        /// New syntax only: a `let` that is not `let mut`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        immutable: Option<bool>,
    },
    FunctionDeclaration {
        #[serde(default)]
        name: Option<Box<Node>>,
        params: Vec<Node>,
        #[serde(default)]
        return_type: Option<Box<Node>>,
        #[serde(default)]
        body: Option<Box<Node>>,
        exported: bool,
    },
    ComponentDeclaration {
        #[serde(default)]
        name: Option<Box<Node>>,
        params: Vec<Node>,
        #[serde(default)]
        body: Option<Box<Node>>,
        exported: bool,
        allows_children: bool,
    },
    /// `state name: type = init;`: a `VariableDeclaration` re-typed by the
    /// parser (`parser/index.mjs:190`), same props.
    StateDeclaration {
        kind: String,
        #[serde(default)]
        name: Option<Box<Node>>,
        #[serde(default)]
        type_annotation: Option<Box<Node>>,
        #[serde(default)]
        initializer: Option<Box<Node>>,
        exported: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        immutable: Option<bool>,
    },
    NamespaceDeclaration {
        #[serde(default)]
        name: Option<Box<Node>>,
        /// A member that failed to parse is `null` (`parser/index.mjs:546`).
        members: Vec<Option<Node>>,
        exported: bool,
    },
    Parameter {
        name: Box<Node>,
        #[serde(default)]
        type_annotation: Option<Box<Node>>,
        #[serde(default)]
        default_value: Option<Box<Node>>,
        /// Set by component parameters only (`parser/index.mjs:598`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        optional: Option<bool>,
    },

    BxElement {
        name: String,
        attributes: Vec<Node>,
        children: Vec<Node>,
        self_closing: bool,
    },
    BxFragment {
        children: Vec<Node>,
    },
    BxAttribute {
        name: String,
        #[serde(default)]
        value: Option<Box<Node>>,
    },
    BxSpreadAttribute {
        #[serde(default)]
        expression: Option<Box<Node>>,
    },
    BxText {
        value: String,
        raw: String,
    },
    BxExpressionChild {
        #[serde(default)]
        expression: Option<Box<Node>>,
    },

    BlockStatement {
        body: Vec<Node>,
    },
    IfStatement {
        #[serde(default)]
        test: Option<Box<Node>>,
        #[serde(default)]
        consequent: Option<Box<Node>>,
        #[serde(default)]
        alternate: Option<Box<Node>>,
    },
    WhileStatement {
        #[serde(default)]
        test: Option<Box<Node>>,
        #[serde(default)]
        body: Option<Box<Node>>,
    },
    ForStatement {
        #[serde(default)]
        init: Option<Box<Node>>,
        #[serde(default)]
        test: Option<Box<Node>>,
        #[serde(default)]
        update: Option<Box<Node>>,
        #[serde(default)]
        body: Option<Box<Node>>,
    },
    ReturnStatement {
        #[serde(default)]
        argument: Option<Box<Node>>,
    },
    BreakStatement {},
    ContinueStatement {},
    ExpressionStatement {
        expression: Box<Node>,
    },
    AsmBlock {
        body: String,
    },

    Identifier {
        name: String,
        /// `#name`: a compile-time name (`parser/index.mjs:1036`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compile_time: Option<bool>,
        /// Import specifiers `a as b`: the imported name (`:502`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        imported: Option<String>,
    },
    IntegerLiteral {
        value: f64,
        raw: String,
        radix: u32,
    },
    DecimalLiteral {
        numerator: f64,
        denominator: f64,
        raw: String,
    },
    BooleanLiteral {
        value: bool,
    },
    StringLiteral {
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unterminated: Option<bool>,
    },
    TemplateLiteral {
        parts: Vec<Node>,
    },
    TemplateText {
        value: String,
    },
    TemplateField {
        expression: Box<Node>,
        #[serde(default)]
        width: Option<Box<Node>>,
    },
    ArrayLiteral {
        elements: Vec<Node>,
    },
    RecordLiteral {
        properties: Vec<Node>,
    },
    RecordProperty {
        key: String,
        value: Box<Node>,
    },

    AssignmentExpression {
        operator: String,
        left: Box<Node>,
        #[serde(default)]
        right: Option<Box<Node>>,
    },
    BinaryExpression {
        operator: String,
        left: Box<Node>,
        right: Box<Node>,
    },
    ConditionalExpression {
        test: Box<Node>,
        #[serde(default)]
        consequent: Option<Box<Node>>,
        #[serde(default)]
        alternate: Option<Box<Node>>,
    },
    UnaryExpression {
        operator: String,
        argument: Box<Node>,
    },
    UpdateExpression {
        operator: String,
        argument: Box<Node>,
        prefix: bool,
    },
    CallExpression {
        callee: Box<Node>,
        args: Vec<Node>,
    },
    MemberExpression {
        object: Box<Node>,
        property: Box<Node>,
    },
    IndexExpression {
        object: Box<Node>,
        #[serde(default)]
        index: Option<Box<Node>>,
    },

    TypeReference {
        name: String,
        type_arguments: Vec<Node>,
    },
    Decorator {
        name: String,
        args: Vec<Node>,
    },
}

impl NodeKind {
    /// The JS `type` string: the variant name.
    #[must_use]
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Program { .. } => "Program",
            Self::ImportDeclaration { .. } => "ImportDeclaration",
            Self::VariableDeclaration { .. } => "VariableDeclaration",
            Self::FunctionDeclaration { .. } => "FunctionDeclaration",
            Self::ComponentDeclaration { .. } => "ComponentDeclaration",
            Self::StateDeclaration { .. } => "StateDeclaration",
            Self::NamespaceDeclaration { .. } => "NamespaceDeclaration",
            Self::Parameter { .. } => "Parameter",
            Self::BxElement { .. } => "BxElement",
            Self::BxFragment { .. } => "BxFragment",
            Self::BxAttribute { .. } => "BxAttribute",
            Self::BxSpreadAttribute { .. } => "BxSpreadAttribute",
            Self::BxText { .. } => "BxText",
            Self::BxExpressionChild { .. } => "BxExpressionChild",
            Self::BlockStatement { .. } => "BlockStatement",
            Self::IfStatement { .. } => "IfStatement",
            Self::WhileStatement { .. } => "WhileStatement",
            Self::ForStatement { .. } => "ForStatement",
            Self::ReturnStatement { .. } => "ReturnStatement",
            Self::BreakStatement {} => "BreakStatement",
            Self::ContinueStatement {} => "ContinueStatement",
            Self::ExpressionStatement { .. } => "ExpressionStatement",
            Self::AsmBlock { .. } => "AsmBlock",
            Self::Identifier { .. } => "Identifier",
            Self::IntegerLiteral { .. } => "IntegerLiteral",
            Self::DecimalLiteral { .. } => "DecimalLiteral",
            Self::BooleanLiteral { .. } => "BooleanLiteral",
            Self::StringLiteral { .. } => "StringLiteral",
            Self::TemplateLiteral { .. } => "TemplateLiteral",
            Self::TemplateText { .. } => "TemplateText",
            Self::TemplateField { .. } => "TemplateField",
            Self::ArrayLiteral { .. } => "ArrayLiteral",
            Self::RecordLiteral { .. } => "RecordLiteral",
            Self::RecordProperty { .. } => "RecordProperty",
            Self::AssignmentExpression { .. } => "AssignmentExpression",
            Self::BinaryExpression { .. } => "BinaryExpression",
            Self::ConditionalExpression { .. } => "ConditionalExpression",
            Self::UnaryExpression { .. } => "UnaryExpression",
            Self::UpdateExpression { .. } => "UpdateExpression",
            Self::CallExpression { .. } => "CallExpression",
            Self::MemberExpression { .. } => "MemberExpression",
            Self::IndexExpression { .. } => "IndexExpression",
            Self::TypeReference { .. } => "TypeReference",
            Self::Decorator { .. } => "Decorator",
        }
    }
}
