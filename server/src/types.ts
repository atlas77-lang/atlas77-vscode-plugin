export interface Span {
    start: number;
    end: number;
    path: string;
}

export interface CompilerError {
    message: string;
    span: Span;
    kind: "error" | "warning" | "note" | "info";
}

export interface HirType {
    Integer?: { size_in_bits: number };
    LiteralInteger?: { value: number; span: Span };
    Float?: { size_in_bits: number };
    LiteralFloat?: { value: number; span: Span };
    UnsignedInteger?: { size_in_bits: number };
    LiteralUnsignedInteger?: { value: number; span: Span };
    Char?: {};
    Boolean?: {};
    String?: {};
    Slice?: { inner: HirType };
    InlineArray?: { inner: HirType; size: number };
    Named?: { name: string; span: Span };
    PtrTy?: { inner: HirType; is_const: boolean; span: Span };
    Unit?: Record<string, never>;
    Error?: {};
    Uninitialized?: {};
    Generic?: { name: string, inner: HirType, span: Span };
    Function?: { ret_ty: HirType; ret_ty_span: Span; params: Array<HirType>; param_spans: Array<Span>; span: Span }
}

export interface LetStatement {
    span: Span;
    name: string;
    name_span: Span;
    ty: HirType;
    value: any;
}

export interface FunctionBody {
    span: Span;
    statements: Array<{ Let?: LetStatement }>;
}

export interface FunctionDefinition {
    span: Span;
    name: string;
    name_span: Span;
    body: FunctionBody;
}

export interface HirPayload {
    hir: {
        body: {
            functions: Record<string, FunctionDefinition>;
        };
    };
    errors: CompilerError[];
}