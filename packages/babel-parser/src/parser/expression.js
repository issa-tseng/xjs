// @flow

// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

import { types as tt, type TokenType } from "../tokenizer/types";
import * as N from "../types";
import LValParser from "./lval";
import {
  isKeyword,
  isReservedWord,
  isStrictReservedWord,
  isStrictBindReservedWord,
} from "../util/identifier";
import type { Pos, Position } from "../util/location";
import * as charCodes from "charcodes";
import {
  BIND_OUTSIDE,
  BIND_VAR,
  functionFlags,
  SCOPE_ARROW,
  SCOPE_CLASS,
  SCOPE_DIRECT_SUPER,
  SCOPE_SUPER,
  SCOPE_PROGRAM,
} from "../util/scopeflags";

const unwrapParenthesizedExpression = node => {
  return node.type === "ParenthesizedExpression"
    ? unwrapParenthesizedExpression(node.expression)
    : node;
};

export default class ExpressionParser extends LValParser {
  // Forward-declaration: defined in statement.js
  +parseBlock: (
    allowDirectives?: boolean,
    createNewLexicalScope?: boolean,
  ) => N.BlockStatement;
  +parseClass: (
    node: N.Class,
    isStatement: boolean,
    optionalId?: boolean,
  ) => N.Class;
  +parseDecorators: (allowExport?: boolean) => void;
  +parseFunction: <T: N.NormalFunction>(
    node: T,
    statement?: number,
    allowExpressionBody?: boolean,
    isAsync?: boolean,
  ) => T;
  +parseFunctionParams: (node: N.Function, allowModifiers?: boolean) => void;
  +takeDecorators: (node: N.HasDecorators) => void;

  // Check if property name clashes with already added.
  // Object/class getters and setters are not allowed to clash —
  // either with each other or with an init property — and in
  // strict mode, init properties are also not allowed to be repeated.

  checkPropClash(
    prop: N.ObjectMember | N.SpreadElement,
    propHash: { [key: string]: boolean },
  ): void {
    if (
      prop.type === "SpreadElement" ||
      prop.computed ||
      prop.kind ||
      // $FlowIgnore
      prop.shorthand
    ) {
      return;
    }

    const key = prop.key;
    // It is either an Identifier or a String/NumericLiteral
    const name = key.type === "Identifier" ? key.name : String(key.value);

    if (name === "__proto__") {
      if (propHash.proto) {
        this.raise(key.start, "Redefinition of __proto__ property");
      }
      propHash.proto = true;
    }
  }

  // Convenience method to parse an Expression only
  getExpression(): N.Expression {
    this.scope.enter(SCOPE_PROGRAM);
    this.nextToken();
    const expr = this.parseExpression();
    if (!this.match(tt.eof)) {
      this.unexpected();
    }
    expr.comments = this.state.comments;
    return expr;
  }

  // ### Expression parsing

  // These nest, from the most general expression type at the top to
  // 'atomic', nondivisible expression types at the bottom. Most of
  // the functions will simply let the function (s) below them parse,
  // and, *if* the syntactic construct they handle is present, wrap
  // the AST node that the inner parser gave them in another node.

  // Parse a full expression. The optional arguments are used to
  // forbid the `in` operator (in for loops initialization expressions)
  // and provide reference for storing '=' operator inside shorthand
  // property assignment in contexts where both object expression
  // and object pattern might appear (so it's possible to raise
  // delayed syntax error at correct position).

  parseExpression(noIn?: boolean, refShorthandDefaultPos?: Pos): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    const expr = this.parseMaybeAssign(noIn, refShorthandDefaultPos);
    if (this.match(tt.comma)) {
      const node = this.startNodeAt(startPos, startLoc);
      node.expressions = [expr];
      while (this.eat(tt.comma)) {
        node.expressions.push(
          this.parseMaybeAssign(noIn, refShorthandDefaultPos),
        );
      }
      this.toReferencedList(node.expressions);
      return this.finishNode(node, "SequenceExpression");
    }
    return expr;
  }

  // Parse an assignment expression. This includes applications of
  // operators like `+=`.

  parseMaybeAssign(
    noIn?: ?boolean,
    refShorthandDefaultPos?: ?Pos,
    afterLeftParse?: Function,
    refNeedsArrowPos?: ?Pos,
  ): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    if (this.isContextual("yield")) {
      if (this.scope.inGenerator) {
        let left = this.parseYield(noIn);
        if (afterLeftParse) {
          left = afterLeftParse.call(this, left, startPos, startLoc);
        }
        return left;
      } else {
        // The tokenizer will assume an expression is allowed after
        // `yield`, but this isn't that kind of yield
        this.state.exprAllowed = false;
      }
    }

    const oldCommaAfterSpreadAt = this.state.commaAfterSpreadAt;
    this.state.commaAfterSpreadAt = -1;

    let failOnShorthandAssign;
    if (refShorthandDefaultPos) {
      failOnShorthandAssign = false;
    } else {
      refShorthandDefaultPos = { start: 0 };
      failOnShorthandAssign = true;
    }

    if (this.match(tt.parenL) || this.match(tt.name)) {
      this.state.potentialArrowAt = this.state.start;
    }

    let left = this.parseMaybeConditional(
      noIn,
      refShorthandDefaultPos,
      refNeedsArrowPos,
    );
    if (afterLeftParse) {
      left = afterLeftParse.call(this, left, startPos, startLoc);
    }
    if (this.state.type.isAssign) {
      const node = this.startNodeAt(startPos, startLoc);
      const operator = this.state.value;
      node.operator = operator;

      if (operator === "??=") {
        this.expectPlugin("nullishCoalescingOperator");
        this.expectPlugin("logicalAssignment");
      }
      if (operator === "||=" || operator === "&&=") {
        this.expectPlugin("logicalAssignment");
      }
      node.left = this.match(tt.eq)
        ? this.toAssignable(left, undefined, "assignment expression")
        : left;
      refShorthandDefaultPos.start = 0; // reset because shorthand default was used correctly

      this.checkLVal(left, undefined, undefined, "assignment expression");

      const maybePattern = unwrapParenthesizedExpression(left);

      let patternErrorMsg;
      if (maybePattern.type === "ObjectPattern") {
        patternErrorMsg = "`({a}) = 0` use `({a} = 0)`";
      } else if (maybePattern.type === "ArrayPattern") {
        patternErrorMsg = "`([a]) = 0` use `([a] = 0)`";
      }

      if (
        patternErrorMsg &&
        ((left.extra && left.extra.parenthesized) ||
          left.type === "ParenthesizedExpression")
      ) {
        this.raise(
          maybePattern.start,
          `You're trying to assign to a parenthesized expression, eg. instead of ${patternErrorMsg}`,
        );
      }

      if (patternErrorMsg) this.checkCommaAfterRestFromSpread();
      this.state.commaAfterSpreadAt = oldCommaAfterSpreadAt;

      this.next();
      node.right = this.parseMaybeAssign(noIn);
      return this.finishNode(node, "AssignmentExpression");
    } else if (failOnShorthandAssign && refShorthandDefaultPos.start) {
      this.unexpected(refShorthandDefaultPos.start);
    }

    this.state.commaAfterSpreadAt = oldCommaAfterSpreadAt;

    return left;
  }

  // Parse a ternary conditional (`?:`) operator.

  parseMaybeConditional(
    noIn: ?boolean,
    refShorthandDefaultPos: Pos,
    refNeedsArrowPos?: ?Pos,
  ): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    const potentialArrowAt = this.state.potentialArrowAt;
    const expr = this.parseExprOps(noIn, refShorthandDefaultPos);

    if (
      (expr.type === "ArrowFunctionExpression" ||
        expr.type === "AccessFunctionExpression") &&
      expr.start === potentialArrowAt
    ) {
      return expr;
    }
    if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;

    return this.parseConditional(
      expr,
      noIn,
      startPos,
      startLoc,
      refNeedsArrowPos,
    );
  }

  parseConditional(
    expr: N.Expression,
    noIn: ?boolean,
    startPos: number,
    startLoc: Position,
    // FIXME: Disabling this for now since can't seem to get it to play nicely
    // eslint-disable-next-line no-unused-vars
    refNeedsArrowPos?: ?Pos,
  ): N.Expression {
    if (this.eat(tt.question)) {
      const node = this.startNodeAt(startPos, startLoc);
      node.test = expr;
      node.consequent = this.parseMaybeAssign();
      this.expect(tt.colon);
      node.alternate = this.parseMaybeAssign(noIn);
      return this.finishNode(node, "ConditionalExpression");
    }
    return expr;
  }

  // Start the precedence parser.

  parseExprOps(noIn: ?boolean, refShorthandDefaultPos: Pos): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    const potentialArrowAt = this.state.potentialArrowAt;
    const expr = this.parseMaybeUnary(refShorthandDefaultPos);

    if (
      (expr.type === "ArrowFunctionExpression" ||
        expr.type === "AccessFunctionExpression") &&
      expr.start === potentialArrowAt
    ) {
      return expr;
    }
    if (refShorthandDefaultPos && refShorthandDefaultPos.start) {
      return expr;
    }

    return this.parseExprOp(expr, startPos, startLoc, -1, noIn);
  }

  // Parse binary operators with the operator precedence parsing
  // algorithm. `left` is the left-hand side of the operator.
  // `minPrec` provides context that allows the function to stop and
  // defer further parser to one of its callers when it encounters an
  // operator that has a lower precedence than the set it is parsing.

  parseExprOp(
    left: N.Expression,
    leftStartPos: number,
    leftStartLoc: Position,
    minPrec: number,
    noIn: ?boolean,
  ): N.Expression {
    const prec = this.state.type.binop;
    if (prec != null && (!noIn || !this.match(tt._in))) {
      if (prec > minPrec) {
        const operator = this.state.value;
        if (operator === "|>" && this.state.inFSharpPipelineDirectBody) {
          return left;
        }
        const node = this.startNodeAt(leftStartPos, leftStartLoc);
        node.left = left;
        node.operator = operator;
        if (
          operator === "**" &&
          left.type === "UnaryExpression" &&
          (this.options.createParenthesizedExpressions ||
            !(left.extra && left.extra.parenthesized))
        ) {
          this.raise(
            left.argument.start,
            "Illegal expression. Wrap left hand side or entire exponentiation in parentheses.",
          );
        }

        const op = this.state.type;

        if (op === tt.pipeline) {
          this.expectPlugin("pipelineOperator");
          this.state.inPipeline = true;
          this.checkPipelineAtInfixOperator(left, leftStartPos);
        } else if (op === tt.nullishCoalescing) {
          this.expectPlugin("nullishCoalescingOperator");
        }

        this.next();

        if (
          op === tt.pipeline &&
          this.getPluginOption("pipelineOperator", "proposal") === "minimal"
        ) {
          if (
            this.match(tt.name) &&
            this.state.value === "await" &&
            this.scope.inAsync
          ) {
            throw this.raise(
              this.state.start,
              `Unexpected "await" after pipeline body; await must have parentheses in minimal proposal`,
            );
          }
        }

        node.right = this.parseExprOpRightExpr(op, prec, noIn);

        this.finishNode(
          node,
          op === tt.logicalOR ||
            op === tt.logicalAND ||
            op === tt.nullishCoalescing
            ? "LogicalExpression"
            : "BinaryExpression",
        );

        return this.parseExprOp(
          node,
          leftStartPos,
          leftStartLoc,
          minPrec,
          noIn,
        );
      }
    }
    return left;
  }

  // Helper function for `parseExprOp`. Parse the right-hand side of binary-
  // operator expressions, then apply any operator-specific functions.

  parseExprOpRightExpr(
    op: TokenType,
    prec: number,
    noIn: ?boolean,
  ): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    switch (op) {
      case tt.pipeline:
        switch (this.getPluginOption("pipelineOperator", "proposal")) {
          case "smart":
            return this.withTopicPermittingContext(() => {
              return this.parseSmartPipelineBody(
                this.parseExprOpBaseRightExpr(op, prec, noIn),
                startPos,
                startLoc,
              );
            });
          case "fsharp":
            return this.withSoloAwaitPermittingContext(() => {
              return this.parseFSharpPipelineBody(prec, noIn);
            });
        }
      // falls through

      default:
        return this.parseExprOpBaseRightExpr(op, prec, noIn);
    }
  }

  // Helper function for `parseExprOpRightExpr`. Parse the right-hand side of
  // binary-operator expressions without applying any operator-specific functions.

  parseExprOpBaseRightExpr(
    op: TokenType,
    prec: number,
    noIn: ?boolean,
  ): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;

    return this.parseExprOp(
      this.parseMaybeUnary(),
      startPos,
      startLoc,
      op.rightAssociative ? prec - 1 : prec,
      noIn,
    );
  }

  // Parse unary operators, both prefix and postfix.

  parseMaybeUnary(refShorthandDefaultPos: ?Pos): N.Expression {
    if (
      this.isContextual("await") &&
      (this.scope.inAsync ||
        (!this.scope.inFunction && this.options.allowAwaitOutsideFunction))
    ) {
      return this.parseAwait();
    } else if (this.state.type.prefix) {
      const node = this.startNode();
      const update = this.match(tt.incDec);
      node.operator = this.state.value;
      node.prefix = true;

      // definitely a hack but i don't know what question value does.
      if (this.match(tt.question)) node.operator = '?';

      if (node.operator === "throw") {
        this.expectPlugin("throwExpressions");
      }
      this.next();

      node.argument = this.parseMaybeUnary();

      if (refShorthandDefaultPos && refShorthandDefaultPos.start) {
        this.unexpected(refShorthandDefaultPos.start);
      }

      if (update) {
        this.checkLVal(node.argument, undefined, undefined, "prefix operation");
      } else if (this.state.strict && node.operator === "delete") {
        const arg = node.argument;

        if (arg.type === "Identifier") {
          this.raise(node.start, "Deleting local variable in strict mode");
        } else if (
          arg.type === "MemberExpression" &&
          arg.property.type === "PrivateName"
        ) {
          this.raise(node.start, "Deleting a private field is not allowed");
        }
      }

      return this.finishNode(
        node,
        update ? "UpdateExpression" : "UnaryExpression",
      );
    }

    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    let expr = this.parseExprSubscripts(refShorthandDefaultPos);
    if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
    while (this.state.type.postfix && !this.canInsertSemicolon()) {
      const node = this.startNodeAt(startPos, startLoc);
      node.operator = this.state.value;
      node.prefix = false;
      node.argument = expr;
      this.checkLVal(expr, undefined, undefined, "postfix operation");
      this.next();
      expr = this.finishNode(node, "UpdateExpression");
    }
    return expr;
  }

  // Parse call, dot, and `[]`-subscript expressions.

  parseExprSubscripts(refShorthandDefaultPos: ?Pos): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    const potentialArrowAt = this.state.potentialArrowAt;
    const expr = this.parseExprAtom(refShorthandDefaultPos);

    if (
      (expr.type === "ArrowFunctionExpression" ||
        expr.type === "AccessFunctionExpression") &&
      expr.start === potentialArrowAt
    ) {
      return expr;
    }

    if (refShorthandDefaultPos && refShorthandDefaultPos.start) {
      return expr;
    }

    return this.parseSubscripts(expr, startPos, startLoc);
  }

  parseSubscripts(
    base: N.Expression,
    startPos: number,
    startLoc: Position,
    noCalls?: ?boolean,
  ): N.Expression {
    const maybeAsyncArrow = this.atPossibleAsync(base);

    const state = {
      optionalChainMember: false,
      stop: false,
    };
    do {
      base = this.parseSubscript(
        base,
        startPos,
        startLoc,
        noCalls,
        state,
        maybeAsyncArrow,
      );
    } while (!state.stop);
    return base;
  }

  /**
   * @param state Set 'state.stop = true' to indicate that we should stop parsing subscripts.
   *   state.optionalChainMember to indicate that the member is currently in OptionalChain
   */
  parseSubscript(
    base: N.Expression,
    startPos: number,
    startLoc: Position,
    noCalls: ?boolean,
    state: N.ParseSubscriptState,
    maybeAsyncArrow: boolean,
  ): N.Expression {
    if (!noCalls && this.eat(tt.doubleColon)) {
      const node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.callee = this.parseNoCallExpr();
      state.stop = true;
      return this.parseSubscripts(
        this.finishNode(node, "BindExpression"),
        startPos,
        startLoc,
        noCalls,
      );
    } else if (this.match(tt.questionDot)) {
      this.expectPlugin("optionalChaining");
      state.optionalChainMember = true;
      if (noCalls && this.lookahead().type === tt.parenL) {
        state.stop = true;
        return base;
      }
      this.next();

      const node = this.startNodeAt(startPos, startLoc);

      if (this.eat(tt.bracketL)) {
        node.object = base;
        node.property = this.parseExpression();
        node.computed = true;
        node.optional = true;
        this.expect(tt.bracketR);
        return this.finishNode(node, "OptionalMemberExpression");
      } else if (this.eat(tt.parenL)) {
        node.callee = base;
        node.arguments = this.parseCallExpressionArguments(tt.parenR, false);
        node.optional = true;
        return this.finishNode(node, "OptionalCallExpression");
      } else {
        node.object = base;
        node.property = this.parseIdentifier(true);
        node.computed = false;
        node.optional = true;
        return this.finishNode(node, "OptionalMemberExpression");
      }
    } else if (this.eat(tt.dot)) {
      const node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseMaybePrivateName();
      node.computed = false;
      if (state.optionalChainMember) {
        node.optional = false;
        return this.finishNode(node, "OptionalMemberExpression");
      }
      return this.finishNode(node, "MemberExpression");
    } else if (this.eat(tt.bracketL)) {
      const node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseExpression();
      node.computed = true;
      this.expect(tt.bracketR);
      if (state.optionalChainMember) {
        node.optional = false;
        return this.finishNode(node, "OptionalMemberExpression");
      }
      return this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.match(tt.parenL)) {
      const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
      const oldYieldPos = this.state.yieldPos;
      const oldAwaitPos = this.state.awaitPos;
      this.state.maybeInArrowParameters = true;
      this.state.yieldPos = 0;
      this.state.awaitPos = 0;

      this.next();

      let node = this.startNodeAt(startPos, startLoc);
      node.callee = base;

      const oldCommaAfterSpreadAt = this.state.commaAfterSpreadAt;
      this.state.commaAfterSpreadAt = -1;

      node.arguments = this.parseCallExpressionArguments(
        tt.parenR,
        maybeAsyncArrow,
        base.type === "Import",
        base.type !== "Super",
      );
      if (!state.optionalChainMember) {
        this.finishCallExpression(node);
      } else {
        this.finishOptionalCallExpression(node);
      }

      if (maybeAsyncArrow && this.shouldParseAsyncArrow()) {
        state.stop = true;

        this.checkCommaAfterRestFromSpread();

        node = this.parseAsyncArrowFromCallExpression(
          this.startNodeAt(startPos, startLoc),
          node,
        );
        this.checkYieldAwaitInDefaultParams();
        this.state.yieldPos = oldYieldPos;
        this.state.awaitPos = oldAwaitPos;
      } else {
        this.toReferencedListDeep(node.arguments);

        // We keep the old value if it isn't null, for cases like
        //   (x = async(yield)) => {}
        this.state.yieldPos = oldYieldPos || this.state.yieldPos;
        this.state.awaitPos = oldAwaitPos || this.state.awaitPos;
      }

      this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
      this.state.commaAfterSpreadAt = oldCommaAfterSpreadAt;

      return node;
    } else if (this.match(tt.backQuote)) {
      return this.parseTaggedTemplateExpression(
        startPos,
        startLoc,
        base,
        state,
      );
    } else {
      state.stop = true;
      return base;
    }
  }

  parseTaggedTemplateExpression(
    startPos: number,
    startLoc: Position,
    base: N.Expression,
    state: N.ParseSubscriptState,
    typeArguments?: ?N.TsTypeParameterInstantiation,
  ): N.TaggedTemplateExpression {
    const node: N.TaggedTemplateExpression = this.startNodeAt(
      startPos,
      startLoc,
    );
    node.tag = base;
    node.quasi = this.parseTemplate(true);
    if (typeArguments) node.typeParameters = typeArguments;
    if (state.optionalChainMember) {
      this.raise(
        startPos,
        "Tagged Template Literals are not allowed in optionalChain",
      );
    }
    return this.finishNode(node, "TaggedTemplateExpression");
  }

  atPossibleAsync(base: N.Expression): boolean {
    return (
      base.type === "Identifier" &&
      base.name === "async" &&
      this.state.lastTokEnd === base.end &&
      !this.canInsertSemicolon() &&
      this.input.slice(base.start, base.end) === "async"
    );
  }

  finishCallExpression(node: N.CallExpression): N.CallExpression {
    if (node.callee.type === "Import") {
      if (node.arguments.length !== 1) {
        this.raise(node.start, "import() requires exactly one argument");
      }

      const importArg = node.arguments[0];
      if (importArg && importArg.type === "SpreadElement") {
        this.raise(importArg.start, "... is not allowed in import()");
      }
    }
    return this.finishNode(node, "CallExpression");
  }

  finishOptionalCallExpression(node: N.CallExpression): N.CallExpression {
    if (node.callee.type === "Import") {
      if (node.arguments.length !== 1) {
        this.raise(node.start, "import() requires exactly one argument");
      }

      const importArg = node.arguments[0];
      if (importArg && importArg.type === "SpreadElement") {
        this.raise(importArg.start, "... is not allowed in import()");
      }
    }
    return this.finishNode(node, "OptionalCallExpression");
  }

  parseCallExpressionArguments(
    close: TokenType,
    possibleAsyncArrow: boolean,
    dynamicImport?: boolean,
    allowPlaceholder?: boolean,
  ): $ReadOnlyArray<?N.Expression> {
    const elts = [];
    let innerParenStart;
    let first = true;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = false;

    while (!this.eat(close)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma);
        if (this.eat(close)) {
          if (dynamicImport) {
            this.raise(
              this.state.lastTokStart,
              "Trailing comma is disallowed inside import(...) arguments",
            );
          }
          break;
        }
      }

      // we need to make sure that if this is an async arrow functions,
      // that we don't allow inner parens inside the params
      if (this.match(tt.parenL) && !innerParenStart) {
        innerParenStart = this.state.start;
      }

      elts.push(
        this.parseExprListItem(
          false,
          possibleAsyncArrow ? { start: 0 } : undefined,
          possibleAsyncArrow ? { start: 0 } : undefined,
          allowPlaceholder,
        ),
      );
    }

    // we found an async arrow function so let's not allow any inner parens
    if (possibleAsyncArrow && innerParenStart && this.shouldParseAsyncArrow()) {
      this.unexpected();
    }

    this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;

    return elts;
  }

  shouldParseAsyncArrow(): boolean {
    return (this.match(tt.arrow) || this.match(tt.singleArrow)) && !this.canInsertSemicolon();
  }

  parseAsyncArrowFromCallExpression(
    node: N.ArrowFunctionExpression,
    call: N.CallExpression,
  ): N.ArrowFunctionExpression {
    node.operator = this.state.type.label;
    this.eat(tt.singleArrow) || this.expect(tt.arrow);
    this.parseArrowExpression(node, call.arguments, true);
    return node;
  }

  // Parse a no-call expression (like argument of `new` or `::` operators).

  parseNoCallExpr(): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    return this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true);
  }

  // Parse an atomic expression — either a single token that is an
  // expression, an expression started by a keyword like `function` or
  // `new`, or an expression wrapped in punctuation like `()`, `[]`,
  // or `{}`.

  parseExprAtom(refShorthandDefaultPos?: ?Pos): N.Expression {
    // If a division operator appears in an expression position, the
    // tokenizer got confused, and we force it to read a regexp instead.
    if (this.state.type === tt.slash) this.readRegexp();

    const canBeArrow = this.state.potentialArrowAt === this.state.start;
    let node;

    switch (this.state.type) {
      case tt._super:
        if (!this.scope.allowSuper && !this.options.allowSuperOutsideMethod) {
          this.raise(
            this.state.start,
            "super is only allowed in object methods and classes",
          );
        }

        node = this.startNode();
        this.next();
        if (
          this.match(tt.parenL) &&
          !this.scope.allowDirectSuper &&
          !this.options.allowSuperOutsideMethod
        ) {
          this.raise(
            node.start,
            "super() is only valid inside a class constructor of a subclass. " +
              "Maybe a typo in the method name ('constructor') or not extending another class?",
          );
        }

        if (
          !this.match(tt.parenL) &&
          !this.match(tt.bracketL) &&
          !this.match(tt.dot)
        ) {
          this.unexpected();
        }

        return this.finishNode(node, "Super");

      case tt._import:
        node = this.startNode();
        this.next();

        if (this.match(tt.dot)) {
          return this.parseImportMetaProperty(node);
        }

        this.expectPlugin("dynamicImport", node.start);

        if (!this.match(tt.parenL)) {
          this.unexpected(null, tt.parenL);
        }
        return this.finishNode(node, "Import");
      case tt._this:
        node = this.startNode();
        this.next();
        return this.finishNode(node, "ThisExpression");

      case tt.dot:
        node = this.startNode();
        this.next();
        node.expression = this.parseMaybeAssign(false, refShorthandDefaultPos);
        return this.finishNode(node, "AccessFunctionExpression");

      case tt.name: {
        node = this.startNode();
        const containsEsc = this.state.containsEsc;
        const id = this.parseIdentifier();

        if (
          !containsEsc &&
          id.name === "async" &&
          this.match(tt._function) &&
          !this.canInsertSemicolon()
        ) {
          this.next();
          return this.parseFunction(node, undefined, true);
        } else if (
          canBeArrow &&
          !containsEsc &&
          id.name === "async" &&
          this.match(tt.name) &&
          !this.canInsertSemicolon()
        ) {
          const params = [this.parseIdentifier()];
          node.operator = this.state.type.label;
          this.eat(tt.singleArrow) || this.expect(tt.arrow);
          // let foo = async bar => {};
          this.parseArrowExpression(node, params, true);
          return node;
        }

        if (
          canBeArrow &&
          (this.match(tt.arrow) || this.match(tt.singleArrow)) &&
          !this.canInsertSemicolon() &&
          !this.state.inPipeParameters
        ) {
          node.operator = this.state.type.label;
          this.next();
          this.parseArrowExpression(node, [id], false);
          return node;
        }

        return id;
      }

      case tt.arrow:
      case tt.singleArrow: {
        node = this.startNode();
        node.operator = this.state.type.label;
        this.next();
        this.parseArrowExpression(node, [], false);
        return node;
      }

      case tt._do: {
        this.expectPlugin("doExpressions");
        const node = this.startNode();
        this.next();
        const oldLabels = this.state.labels;
        this.state.labels = [];
        node.body = this.parseBlock();
        this.state.labels = oldLabels;
        return this.finishNode(node, "DoExpression");
      }

      case tt.regexp: {
        const value = this.state.value;
        node = this.parseLiteral(value.value, "RegExpLiteral");
        node.pattern = value.pattern;
        node.flags = value.flags;
        return node;
      }

      case tt.num:
        return this.parseLiteral(this.state.value, "NumericLiteral");

      case tt.bigint:
        return this.parseLiteral(this.state.value, "BigIntLiteral");

      case tt.string:
        return this.parseLiteral(this.state.value, "StringLiteral");

      case tt._null:
        node = this.startNode();
        this.next();
        return this.finishNode(node, "NullLiteral");

      case tt._true:
      case tt._false:
        return this.parseBooleanLiteral();

      case tt.bitwiseOR:
        return this.parsePipeArrow();

      case tt.parenL:
        return this.parseParenAndDistinguishExpression(canBeArrow);

      case tt.bracketL: {
        const oldInFSharpPipelineDirectBody = this.state
          .inFSharpPipelineDirectBody;
        this.state.inFSharpPipelineDirectBody = false;
        node = this.startNode();
        this.next();
        const elts = this.parseExprList(
          tt.bracketR,
          true,
          refShorthandDefaultPos,
        );
        if (!this.state.maybeInArrowParameters) {
          // This could be an array pattern:
          //   ([a: string, b: string]) => {}
          // In this case, we don't have to call toReferencedList. We will
          // call it, if needed, when we are sure that it is a parenthesized
          // expression by calling toReferencedListDeep.
          this.toReferencedList(elts);
        }
        this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
        if (this.eat(tt._for)) {
          const cnode = this.parseComprehension(
            node,
            elts,
            tt.bracketR,
            refShorthandDefaultPos,
          );
          return this.finishNode(cnode, "ArrayComprehensionExpression");
        } else {
          node.elements = elts;
          return this.finishNode(node, "ArrayExpression");
        }
      }
      case tt.braceL: {
        const oldInFSharpPipelineDirectBody = this.state
          .inFSharpPipelineDirectBody;
        this.state.inFSharpPipelineDirectBody = false;
        const ret = this.parseObj(false, refShorthandDefaultPos);
        this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;
        return ret;
      }
      case tt._function:
        return this.parseFunctionExpression();

      case tt.at:
        this.parseDecorators();

      case tt._class:
        node = this.startNode();
        this.takeDecorators(node);
        return this.parseClass(node, false);

      case tt._new:
        return this.parseNew();

      case tt.backQuote:
        return this.parseTemplate(false);

      case tt.doubleColon: {
        node = this.startNode();
        this.next();
        node.object = null;
        const callee = (node.callee = this.parseNoCallExpr());
        if (callee.type === "MemberExpression") {
          return this.finishNode(node, "BindExpression");
        } else {
          throw this.raise(
            callee.start,
            "Binding should be performed on object property.",
          );
        }
      }

      case tt.hash: {
        if (this.state.inPipeline) {
          node = this.startNode();

          if (
            this.getPluginOption("pipelineOperator", "proposal") !== "smart"
          ) {
            this.raise(
              node.start,
              "Primary Topic Reference found but pipelineOperator not passed 'smart' for 'proposal' option.",
            );
          }

          this.next();
          if (this.primaryTopicReferenceIsAllowedInCurrentTopicContext()) {
            this.registerTopicReference();
            return this.finishNode(node, "PipelinePrimaryTopicReference");
          } else {
            throw this.raise(
              node.start,
              `Topic reference was used in a lexical context without topic binding`,
            );
          }
        }
      }

      default:
        throw this.unexpected();
    }
  }

  parseBooleanLiteral(): N.BooleanLiteral {
    const node = this.startNode();
    node.value = this.match(tt._true);
    this.next();
    return this.finishNode(node, "BooleanLiteral");
  }

  parseMaybePrivateName(): N.PrivateName | N.Identifier {
    const isPrivate = this.match(tt.hash);

    if (isPrivate) {
      this.expectOnePlugin(["classPrivateProperties", "classPrivateMethods"]);
      const node = this.startNode();
      this.next();
      this.assertNoSpace("Unexpected space between # and identifier");
      node.id = this.parseIdentifier(true);
      return this.finishNode(node, "PrivateName");
    } else {
      return this.parseIdentifier(true);
    }
  }

  parseFunctionExpression(): N.FunctionExpression | N.MetaProperty {
    const node = this.startNode();

    // We do not do parseIdentifier here because when parseFunctionExpression
    // is called we already know that the current token is a "name" with the value "function"
    // This will improve perf a tiny little bit as we do not do validation but more importantly
    // here is that parseIdentifier will remove an item from the expression stack
    // if "function" or "class" is parsed as identifier (in objects e.g.), which should not happen here.
    let meta = this.startNode();
    this.next();
    meta = this.createIdentifier(meta, "function");

    if (this.scope.inGenerator && this.eat(tt.dot)) {
      return this.parseMetaProperty(node, meta, "sent");
    }
    return this.parseFunction(node);
  }

  parseMetaProperty(
    node: N.MetaProperty,
    meta: N.Identifier,
    propertyName: string,
  ): N.MetaProperty {
    node.meta = meta;

    if (meta.name === "function" && propertyName === "sent") {
      if (this.isContextual(propertyName)) {
        this.expectPlugin("functionSent");
      } else if (!this.hasPlugin("functionSent")) {
        // The code wasn't `function.sent` but just `function.`, so a simple error is less confusing.
        this.unexpected();
      }
    }

    const containsEsc = this.state.containsEsc;

    node.property = this.parseIdentifier(true);

    if (node.property.name !== propertyName || containsEsc) {
      this.raise(
        node.property.start,
        `The only valid meta property for ${meta.name} is ${
          meta.name
        }.${propertyName}`,
      );
    }

    return this.finishNode(node, "MetaProperty");
  }

  parseImportMetaProperty(node: N.MetaProperty): N.MetaProperty {
    const id = this.createIdentifier(this.startNodeAtNode(node), "import");
    this.expect(tt.dot);

    if (this.isContextual("meta")) {
      this.expectPlugin("importMeta");
    } else if (!this.hasPlugin("importMeta")) {
      this.raise(
        id.start,
        `Dynamic imports require a parameter: import('a.js')`,
      );
    }

    if (!this.inModule) {
      this.raise(
        id.start,
        `import.meta may appear only with 'sourceType: "module"'`,
        { code: "BABEL_PARSER_SOURCETYPE_MODULE_REQUIRED" },
      );
    }
    this.sawUnambiguousESM = true;

    return this.parseMetaProperty(node, id, "meta");
  }

  parseLiteral<T: N.Literal>(
    value: any,
    type: /*T["kind"]*/ string,
    startPos?: number,
    startLoc?: Position,
  ): T {
    startPos = startPos || this.state.start;
    startLoc = startLoc || this.state.startLoc;

    const node = this.startNodeAt(startPos, startLoc);
    this.addExtra(node, "rawValue", value);
    this.addExtra(node, "raw", this.input.slice(startPos, this.state.end));
    node.value = value;
    this.next();
    return this.finishNode(node, type);
  }

  parseParenAndDistinguishExpression(canBeArrow: boolean): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;

    let val;
    this.expect(tt.parenL);

    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    const oldYieldPos = this.state.yieldPos;
    const oldAwaitPos = this.state.awaitPos;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.maybeInArrowParameters = true;
    this.state.yieldPos = 0;
    this.state.awaitPos = 0;
    this.state.inFSharpPipelineDirectBody = false;

    const innerStartPos = this.state.start;
    const innerStartLoc = this.state.startLoc;
    const exprList = [];
    const refShorthandDefaultPos = { start: 0 };
    const refNeedsArrowPos = { start: 0 };
    let first = true;
    let spreadStart;
    let optionalCommaStart;

    while (!this.match(tt.parenR)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma, refNeedsArrowPos.start || null);
        if (this.match(tt.parenR)) {
          optionalCommaStart = this.state.start;
          break;
        }
      }

      if (this.match(tt.ellipsis)) {
        const spreadNodeStartPos = this.state.start;
        const spreadNodeStartLoc = this.state.startLoc;
        spreadStart = this.state.start;
        exprList.push(
          this.parseParenItem(
            this.parseRestBinding(),
            spreadNodeStartPos,
            spreadNodeStartLoc,
          ),
        );

        this.checkCommaAfterRest();

        break;
      } else {
        exprList.push(
          this.parseMaybeAssign(
            false,
            refShorthandDefaultPos,
            this.parseParenItem,
            refNeedsArrowPos,
          ),
        );
      }
    }

    const innerEndPos = this.state.start;
    const innerEndLoc = this.state.startLoc;
    this.expect(tt.parenR);

    this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
    this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;

    let arrowNode = this.startNodeAt(startPos, startLoc);
    if (
      canBeArrow &&
      this.shouldParseArrow() &&
      (arrowNode = this.parseArrow(arrowNode))
    ) {
      this.checkYieldAwaitInDefaultParams();
      this.state.yieldPos = oldYieldPos;
      this.state.awaitPos = oldAwaitPos;
      for (const param of exprList) {
        if (param.extra && param.extra.parenthesized) {
          this.unexpected(param.extra.parenStart);
        }
      }

      this.parseArrowExpression(arrowNode, exprList, false);
      return arrowNode;
    }

    // We keep the old value if it isn't null, for cases like
    //   (x = (yield)) => {}
    this.state.yieldPos = oldYieldPos || this.state.yieldPos;
    this.state.awaitPos = oldAwaitPos || this.state.awaitPos;

    if (!exprList.length) {
      this.unexpected(this.state.lastTokStart);
    }
    if (optionalCommaStart) this.unexpected(optionalCommaStart);
    if (spreadStart) this.unexpected(spreadStart);
    if (refShorthandDefaultPos.start) {
      this.unexpected(refShorthandDefaultPos.start);
    }
    if (refNeedsArrowPos.start) this.unexpected(refNeedsArrowPos.start);

    this.toReferencedListDeep(exprList, /* isParenthesizedExpr */ true);
    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }

    if (!this.options.createParenthesizedExpressions) {
      this.addExtra(val, "parenthesized", true);
      this.addExtra(val, "parenStart", startPos);
      return val;
    }

    const parenExpression = this.startNodeAt(startPos, startLoc);
    parenExpression.expression = val;
    this.finishNode(parenExpression, "ParenthesizedExpression");
    return parenExpression;
  }

  parsePipeArrow(): N.Expression[] {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;
    this.expect(tt.bitwiseOR);

    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    const oldInPipeParameters = this.state.inPipeParameters;
    const oldYieldPos = this.state.yieldPos;
    const oldAwaitPos = this.state.awaitPos;
    this.state.maybeInArrowParameters = true;
    this.state.inPipeParameters = true;
    this.state.yieldPos = 0;
    this.state.awaitPos = 0;

    const exprList = [];
    const refShorthandDefaultPos = { start: 0 };
    const refNeedsArrowPos = { start: 0 };
    let first = true;

    while (!this.match(tt.arrow)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma, refNeedsArrowPos.start || null);
      }

      if (this.match(tt.ellipsis)) {
        exprList.push(this.parseParenItem(this.parseRestBinding()));
        this.checkCommaAfterRest();
        break;
      }

      exprList.push(
        this.parseMaybeAssign(
          false,
          refShorthandDefaultPos,
          this.parseParenItem,
          refNeedsArrowPos,
        ),
      );
    }

    this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
    this.state.inPipeParameters = oldInPipeParameters;

    const arrowNode = this.parseArrow(this.startNodeAt(startPos, startLoc));

    this.checkYieldAwaitInDefaultParams();
    this.state.yieldPos = oldYieldPos;
    this.state.awaitPos = oldAwaitPos;
    for (const param of exprList) {
      if (param.extra && param.extra.parenthesized) {
        this.unexpected(param.extra.parenStart);
      }
    }

    this.parseArrowExpression(arrowNode, exprList, false);
    return arrowNode;
  }

  shouldParseArrow(): boolean {
    return !this.canInsertSemicolon() && !this.state.inPipeParameters;
  }

  parseArrow(node: N.ArrowFunctionExpression): ?N.ArrowFunctionExpression {
    if (this.eat(tt.arrow) || this.eat(tt.singleArrow)) {
      node.operator = this.state.type.label;
      return node;
    }
  }

  parseParenItem(
    node: N.Expression,
    startPos: number, // eslint-disable-line no-unused-vars
    startLoc: Position, // eslint-disable-line no-unused-vars
  ): N.Expression {
    return node;
  }

  // New's precedence is slightly tricky. It must allow its argument to
  // be a `[]` or dot subscript expression, but not a call — at least,
  // not without wrapping it in parentheses. Thus, it uses the noCalls
  // argument to parseSubscripts to prevent it from consuming the
  // argument list.

  parseNew(): N.NewExpression | N.MetaProperty {
    const node = this.startNode();
    const meta = this.parseIdentifier(true);

    if (this.eat(tt.dot)) {
      const metaProp = this.parseMetaProperty(node, meta, "target");

      if (!this.scope.inNonArrowFunction && !this.state.inClassProperty) {
        let error = "new.target can only be used in functions";

        if (this.hasPlugin("classProperties")) {
          error += " or class properties";
        }

        this.raise(metaProp.start, error);
      }

      return metaProp;
    }

    node.callee = this.parseNoCallExpr();

    if (node.callee.type === "Import") {
      this.raise(node.callee.start, "Cannot use new with import(...)");
    } else if (
      node.callee.type === "OptionalMemberExpression" ||
      node.callee.type === "OptionalCallExpression"
    ) {
      this.raise(
        this.state.lastTokEnd,
        "constructors in/after an Optional Chain are not allowed",
      );
    } else if (this.eat(tt.questionDot)) {
      this.raise(
        this.state.start,
        "constructors in/after an Optional Chain are not allowed",
      );
    }

    this.parseNewArguments(node);
    return this.finishNode(node, "NewExpression");
  }

  parseNewArguments(node: N.NewExpression): void {
    if (this.eat(tt.parenL)) {
      const args = this.parseExprList(tt.parenR);
      this.toReferencedList(args);
      // $FlowFixMe (parseExprList should be all non-null in this case)
      node.arguments = args;
    } else {
      node.arguments = [];
    }
  }

  // Parse template expression.

  parseTemplateElement(isTagged: boolean): N.TemplateElement {
    const elem = this.startNode();
    if (this.state.value === null) {
      if (!isTagged) {
        // TODO: fix this
        this.raise(
          this.state.invalidTemplateEscapePosition || 0,
          "Invalid escape sequence in template",
        );
      } else {
        this.state.invalidTemplateEscapePosition = null;
      }
    }
    elem.value = {
      raw: this.input
        .slice(this.state.start, this.state.end)
        .replace(/\r\n?/g, "\n"),
      cooked: this.state.value,
    };
    this.next();
    elem.tail = this.match(tt.backQuote);
    return this.finishNode(elem, "TemplateElement");
  }

  parseTemplate(isTagged: boolean): N.TemplateLiteral {
    const node = this.startNode();
    this.next();
    node.expressions = [];
    let curElt = this.parseTemplateElement(isTagged);
    node.quasis = [curElt];
    while (!curElt.tail) {
      this.expect(tt.dollarBraceL);
      node.expressions.push(this.parseExpression());
      this.expect(tt.braceR);
      node.quasis.push((curElt = this.parseTemplateElement(isTagged)));
    }
    this.next();
    return this.finishNode(node, "TemplateLiteral");
  }

  // Parse an object literal or binding pattern.

  parseObj<T: N.ObjectPattern | N.ObjectExpression>(
    isPattern: boolean,
    refShorthandDefaultPos?: ?Pos,
  ): T {
    const propHash: any = Object.create(null);
    let first = true;
    const node = this.startNode();

    const properties = [];
    this.next();

    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else if (this.eat(tt._for)) {
        if (properties.length > 1)
          this.raise("too many assignments for object comprehension");

        this.parseComprehension(
          node,
          properties[0],
          tt.braceR,
          refShorthandDefaultPos,
        );
        return this.finishNode(node, "ObjectComprehensionExpression");
      } else {
        this.expect(tt.comma);
        if (this.eat(tt.braceR)) break;
      }

      const prop = this.parseObjectMember(isPattern, refShorthandDefaultPos);
      // $FlowIgnore RestElement will never be returned if !isPattern
      if (!isPattern) this.checkPropClash(prop, propHash);

      // $FlowIgnore
      if (prop.shorthand) {
        this.addExtra(prop, "shorthand", true);
      }

      properties.push(prop);
    }

    node.properties = properties;
    return this.finishNode(
      node,
      isPattern ? "ObjectPattern" : "ObjectExpression",
    );
  }

  isAsyncProp(prop: N.ObjectProperty): boolean {
    return (
      !prop.computed &&
      prop.key.type === "Identifier" &&
      prop.key.name === "async" &&
      (this.match(tt.name) ||
        this.match(tt.num) ||
        this.match(tt.string) ||
        this.match(tt.bracketL) ||
        this.state.type.keyword ||
        this.match(tt.star)) &&
      !this.hasPrecedingLineBreak()
    );
  }

  parseObjectMember(
    isPattern: boolean,
    refShorthandDefaultPos: ?Pos,
  ): N.ObjectMember | N.SpreadElement | N.RestElement {
    let decorators = [];
    if (this.match(tt.at)) {
      if (this.hasPlugin("decorators")) {
        this.raise(
          this.state.start,
          "Stage 2 decorators disallow object literal property decorators",
        );
      } else {
        // we needn't check if decorators (stage 0) plugin is enabled since it's checked by
        // the call to this.parseDecorator
        while (this.match(tt.at)) {
          decorators.push(this.parseDecorator());
        }
      }
    }

    const prop = this.startNode();
    let isGenerator = false;
    let isAsync = false;
    let startPos;
    let startLoc;

    if (this.match(tt.ellipsis)) {
      if (decorators.length) this.unexpected();
      if (isPattern) {
        this.next();
        // Don't use parseRestBinding() as we only allow Identifier here.
        prop.argument = this.parseIdentifier();
        this.checkCommaAfterRest();
        return this.finishNode(prop, "RestElement");
      }

      return this.parseSpread();
    }

    if (decorators.length) {
      prop.decorators = decorators;
      decorators = [];
    }

    prop.method = false;

    if (isPattern || refShorthandDefaultPos) {
      startPos = this.state.start;
      startLoc = this.state.startLoc;
    }

    if (!isPattern) {
      isGenerator = this.eat(tt.star);
    }

    const containsEsc = this.state.containsEsc;
    this.parsePropertyName(prop);

    if (!isPattern && !containsEsc && !isGenerator && this.isAsyncProp(prop)) {
      isAsync = true;
      isGenerator = this.eat(tt.star);
      this.parsePropertyName(prop);
    } else {
      isAsync = false;
    }

    this.parseObjPropValue(
      prop,
      startPos,
      startLoc,
      isGenerator,
      isAsync,
      isPattern,
      refShorthandDefaultPos,
      containsEsc,
    );

    return prop;
  }

  isGetterOrSetterMethod(prop: N.ObjectMethod, isPattern: boolean): boolean {
    return (
      !isPattern &&
      !prop.computed &&
      prop.key.type === "Identifier" &&
      (prop.key.name === "get" || prop.key.name === "set") &&
      (this.match(tt.string) || // get "string"() {}
      this.match(tt.num) || // get 1() {}
      this.match(tt.bracketL) || // get ["string"]() {}
      this.match(tt.name) || // get foo() {}
        !!this.state.type.keyword) // get debugger() {}
    );
  }

  getGetterSetterExpectedParamCount(
    method: N.ObjectMethod | N.ClassMethod,
  ): number {
    return method.kind === "get" ? 0 : 1;
  }

  // get methods aren't allowed to have any parameters
  // set methods must have exactly 1 parameter which is not a rest parameter
  checkGetterSetterParams(method: N.ObjectMethod | N.ClassMethod): void {
    const paramCount = this.getGetterSetterExpectedParamCount(method);
    const start = method.start;
    if (method.params.length !== paramCount) {
      if (method.kind === "get") {
        this.raise(start, "getter must not have any formal parameters");
      } else {
        this.raise(start, "setter must have exactly one formal parameter");
      }
    }

    if (
      method.kind === "set" &&
      method.params[method.params.length - 1].type === "RestElement"
    ) {
      this.raise(
        start,
        "setter function argument must not be a rest parameter",
      );
    }
  }

  parseObjectMethod(
    prop: N.ObjectMethod,
    isGenerator: boolean,
    isAsync: boolean,
    isPattern: boolean,
    containsEsc: boolean,
  ): ?N.ObjectMethod {
    if (isAsync || isGenerator || this.match(tt.parenL)) {
      if (isPattern) this.unexpected();
      prop.kind = "method";
      prop.method = true;
      return this.parseMethod(
        prop,
        isGenerator,
        isAsync,
        /* isConstructor */ false,
        false,
        "ObjectMethod",
      );
    }

    if (!containsEsc && this.isGetterOrSetterMethod(prop, isPattern)) {
      if (isGenerator || isAsync) this.unexpected();
      prop.kind = prop.key.name;
      this.parsePropertyName(prop);
      this.parseMethod(
        prop,
        /* isGenerator */ false,
        /* isAsync */ false,
        /* isConstructor */ false,
        false,
        "ObjectMethod",
      );
      this.checkGetterSetterParams(prop);
      return prop;
    }
  }

  parseObjectProperty(
    prop: N.ObjectProperty,
    startPos: ?number,
    startLoc: ?Position,
    isPattern: boolean,
    refShorthandDefaultPos: ?Pos,
  ): ?N.ObjectProperty {
    prop.shorthand = false;

    if (this.eat(tt.colon)) {
      prop.value = isPattern
        ? this.parseMaybeDefault(this.state.start, this.state.startLoc)
        : this.parseMaybeAssign(false, refShorthandDefaultPos);

      return this.finishNode(prop, "ObjectProperty");
    }

    if (!prop.computed && prop.key.type === "Identifier") {
      this.checkReservedWord(prop.key.name, prop.key.start, true, true);

      if (isPattern) {
        prop.value = this.parseMaybeDefault(
          startPos,
          startLoc,
          prop.key.__clone(),
        );
      } else if (this.match(tt.eq) && refShorthandDefaultPos) {
        if (!refShorthandDefaultPos.start) {
          refShorthandDefaultPos.start = this.state.start;
        }
        prop.value = this.parseMaybeDefault(
          startPos,
          startLoc,
          prop.key.__clone(),
        );
      } else {
        prop.value = prop.key.__clone();
      }
      prop.shorthand = true;

      return this.finishNode(prop, "ObjectProperty");
    }
  }

  parseObjPropValue(
    prop: any,
    startPos: ?number,
    startLoc: ?Position,
    isGenerator: boolean,
    isAsync: boolean,
    isPattern: boolean,
    refShorthandDefaultPos: ?Pos,
    containsEsc: boolean,
  ): void {
    const node =
      this.parseObjectMethod(
        prop,
        isGenerator,
        isAsync,
        isPattern,
        containsEsc,
      ) ||
      this.parseObjectProperty(
        prop,
        startPos,
        startLoc,
        isPattern,
        refShorthandDefaultPos,
      );

    if (!node) this.unexpected();

    // $FlowFixMe
    return node;
  }

  parsePropertyName(
    prop: N.ObjectOrClassMember | N.ClassMember | N.TsNamedTypeElementBase,
  ): N.Expression | N.Identifier {
    if (this.eat(tt.bracketL)) {
      (prop: $FlowSubtype<N.ObjectOrClassMember>).computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(tt.bracketR);
    } else {
      const oldInPropertyName = this.state.inPropertyName;
      this.state.inPropertyName = true;
      // We check if it's valid for it to be a private name when we push it.
      (prop: $FlowFixMe).key =
        this.match(tt.num) || this.match(tt.string)
          ? this.parseExprAtom()
          : this.parseMaybePrivateName();

      if (prop.key.type !== "PrivateName") {
        // ClassPrivateProperty is never computed, so we don't assign in that case.
        prop.computed = false;
      }

      this.state.inPropertyName = oldInPropertyName;
    }

    return prop.key;
  }

  // Initialize empty function node.

  initFunction(node: N.BodilessFunctionOrMethodBase, isAsync: ?boolean): void {
    node.id = null;
    node.generator = false;
    node.async = !!isAsync;
  }

  // Parse object or class method.

  parseMethod<T: N.MethodLike>(
    node: T,
    isGenerator: boolean,
    isAsync: boolean,
    isConstructor: boolean,
    allowDirectSuper: boolean,
    type: string,
    inClassScope: boolean = false,
  ): T {
    const oldYieldPos = this.state.yieldPos;
    const oldAwaitPos = this.state.awaitPos;
    this.state.yieldPos = 0;
    this.state.awaitPos = 0;

    this.initFunction(node, isAsync);
    node.generator = !!isGenerator;
    const allowModifiers = isConstructor; // For TypeScript parameter properties
    this.scope.enter(
      functionFlags(isAsync, node.generator) |
        SCOPE_SUPER |
        (inClassScope ? SCOPE_CLASS : 0) |
        (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0),
    );
    this.parseFunctionParams((node: any), allowModifiers);
    this.checkYieldAwaitInDefaultParams();
    this.parseFunctionBodyAndFinish(node, type, true);
    this.scope.exit();

    this.state.yieldPos = oldYieldPos;
    this.state.awaitPos = oldAwaitPos;

    return node;
  }

  // Parse arrow function expression.
  // If the parameters are provided, they will be converted to an
  // assignable list.
  parseArrowExpression(
    node: N.ArrowFunctionExpression,
    params: ?(N.Expression[]),
    isAsync: boolean,
  ): N.ArrowFunctionExpression {
    this.scope.enter(functionFlags(isAsync, false) | SCOPE_ARROW);
    this.initFunction(node, isAsync);

    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    const oldYieldPos = this.state.yieldPos;
    const oldAwaitPos = this.state.awaitPos;
    this.state.maybeInArrowParameters = false;
    this.state.yieldPos = 0;
    this.state.awaitPos = 0;

    if (params) this.setArrowFunctionParameters(node, params);
    this.parseFunctionBody(node, true);

    this.scope.exit();
    this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
    this.state.yieldPos = oldYieldPos;
    this.state.awaitPos = oldAwaitPos;

    return this.finishNode(node, "ArrowFunctionExpression");
  }

  setArrowFunctionParameters(
    node: N.ArrowFunctionExpression,
    params: N.Expression[],
  ): void {
    node.params = this.toAssignableList(
      params,
      true,
      "arrow function parameters",
    );
  }

  isStrictBody(node: { body: N.BlockStatement }): boolean {
    const isBlockStatement = node.body.type === "BlockStatement";

    if (isBlockStatement && node.body.directives.length) {
      for (const directive of node.body.directives) {
        if (directive.value.value === "use strict") {
          return true;
        }
      }
    }

    return false;
  }

  parseFunctionBodyAndFinish(
    node: N.BodilessFunctionOrMethodBase,
    type: string,
    isMethod?: boolean = false,
  ): void {
    // $FlowIgnore (node is not bodiless if we get here)
    this.parseFunctionBody(node, false, isMethod);
    this.finishNode(node, type);
  }

  // Parse function body and check parameters.
  parseFunctionBody(
    node: N.Function,
    allowExpression: ?boolean,
    isMethod?: boolean = false,
  ): void {
    const isExpression = allowExpression && !this.match(tt.braceL);
    const oldStrict = this.state.strict;
    let useStrict = false;

    const oldInParameters = this.state.inParameters;
    this.state.inParameters = false;

    if (isExpression) {
      node.body = this.parseMaybeAssign();
      this.checkParams(node, false, allowExpression);
    } else {
      const nonSimple = !this.isSimpleParamList(node.params);
      if (!oldStrict || nonSimple) {
        useStrict = this.strictDirective(this.state.end);
        // If this is a strict mode function, verify that argument names
        // are not repeated, and it does not try to bind the words `eval`
        // or `arguments`.
        if (useStrict && nonSimple) {
          // This logic is here to align the error location with the estree plugin
          const errorPos =
            // $FlowIgnore
            (node.kind === "method" || node.kind === "constructor") &&
            // $FlowIgnore
            !!node.key
              ? node.key.end
              : node.start;
          this.raise(
            errorPos,
            "Illegal 'use strict' directive in function with non-simple parameter list",
          );
        }
      }
      // Start a new scope with regard to labels
      // flag (restore them to their old value afterwards).
      const oldLabels = this.state.labels;
      this.state.labels = [];
      if (useStrict) this.state.strict = true;
      // Add the params to varDeclaredNames to ensure that an error is thrown
      // if a let/const declaration in the function clashes with one of the params.
      this.checkParams(
        node,
        !oldStrict && !useStrict && !allowExpression && !isMethod && !nonSimple,
        allowExpression,
      );
      node.body = this.parseBlock(true, false);
      this.state.labels = oldLabels;
    }

    this.state.inParameters = oldInParameters;
    // Ensure the function name isn't a forbidden identifier in strict mode, e.g. 'eval'
    if (this.state.strict && node.id) {
      this.checkLVal(node.id, BIND_OUTSIDE, undefined, "function name");
    }
    this.state.strict = oldStrict;
  }

  isSimpleParamList(
    params: $ReadOnlyArray<N.Pattern | N.TSParameterProperty>,
  ): boolean {
    for (let i = 0, len = params.length; i < len; i++) {
      if (params[i].type !== "Identifier") return false;
    }
    return true;
  }

  checkParams(
    node: N.Function,
    allowDuplicates: boolean,
    // eslint-disable-next-line no-unused-vars
    isArrowFunction: ?boolean,
  ): void {
    // $FlowIssue
    const nameHash: {} = Object.create(null);
    for (let i = 0; i < node.params.length; i++) {
      this.checkLVal(
        node.params[i],
        BIND_VAR,
        allowDuplicates ? null : nameHash,
        "function paramter list",
      );
    }
  }

  // Parses a comma-separated list of expressions, and returns them as
  // an array. `close` is the token type that ends the list, and
  // `allowEmpty` can be turned on to allow subsequent commas with
  // nothing in between them to be parsed as `null` (which is needed
  // for array literals).

  parseExprList(
    close: TokenType,
    allowEmpty?: boolean,
    refShorthandDefaultPos?: ?Pos,
  ): $ReadOnlyArray<?N.Expression> {
    const elts = [];
    let first = true;

    while (!this.eat(close)) {
      if (first) {
        first = false;
      } else if (this.match(tt._for)) {
        return elts;
      } else {
        this.expect(tt.comma);
        if (this.eat(close)) break;
      }

      elts.push(this.parseExprListItem(allowEmpty, refShorthandDefaultPos));
    }
    return elts;
  }

  parseExprListItem(
    allowEmpty: ?boolean,
    refShorthandDefaultPos: ?Pos,
    refNeedsArrowPos: ?Pos,
    allowPlaceholder: ?boolean,
  ): ?N.Expression {
    let elt;
    if (allowEmpty && this.match(tt.comma)) {
      elt = null;
    } else if (this.match(tt.ellipsis)) {
      const spreadNodeStartPos = this.state.start;
      const spreadNodeStartLoc = this.state.startLoc;
      elt = this.parseParenItem(
        this.parseSpread(refShorthandDefaultPos, refNeedsArrowPos),
        spreadNodeStartPos,
        spreadNodeStartLoc,
      );
    } else if (this.match(tt.question)) {
      this.expectPlugin("partialApplication");
      if (!allowPlaceholder) {
        this.raise(this.state.start, "Unexpected argument placeholder");
      }
      const node = this.startNode();
      this.next();
      elt = this.finishNode(node, "ArgumentPlaceholder");
    } else {
      elt = this.parseMaybeAssign(
        false,
        refShorthandDefaultPos,
        this.parseParenItem,
        refNeedsArrowPos,
      );
    }
    return elt;
  }

  parseComprehension(
    node: N.Expression,
    body: N.Expression[],
    close: TokenType,
    refShorthandDefaultPos?: ?Pos,
  ): ?N.ArrayComprehensionExpression {
    node.body = body;
    node.loops = [];

    while (true) {
      const loopNode = this.startNode();
      node.loops.push(loopNode);

      loopNode.ival = this.parseMaybeConditional(
        true,
        refShorthandDefaultPos,
      );
      this.toAssignable(loopNode.ival, undefined, "for comprehension value");
      this.checkLVal(loopNode.ival, undefined, undefined, "for comprehension value");
      // TODO: ?? do something with refShorthandDefaultPos if ?.start ?

      if (this.eat(tt.comma)) loopNode.ikey = this.parseIdentifier();

      if (this.eat(tt._in)) {
        loopNode.operator = "in";
      } else if (this.isContextual("of")) {
        this.next();
        loopNode.operator = "of";
      }

      loopNode.right = this.parseMaybeAssign(true, refShorthandDefaultPos);

      if (this.eat(tt._if))
        loopNode.test = this.parseMaybeAssign(true, refShorthandDefaultPos);

      this.finishNode(loopNode, "ComprehensionLoopExpression");

      if (this.eat(close))
        break;
      else
        this.expect(tt._for);
    }

    return node;
  }

  // Parse the next token as an identifier. If `liberal` is true (used
  // when parsing properties), it will also convert keywords into
  // identifiers.

  parseIdentifier(liberal?: boolean): N.Identifier {
    const node = this.startNode();
    const name = this.parseIdentifierName(node.start, liberal);

    return this.createIdentifier(node, name);
  }

  createIdentifier(node: N.Identifier, name: string): N.Identifier {
    node.name = name;
    node.loc.identifierName = name;

    return this.finishNode(node, "Identifier");
  }

  parseIdentifierName(pos: number, liberal?: boolean): string {
    let name: string;

    if (this.match(tt.name)) {
      name = this.state.value;
    } else if (this.state.type.keyword) {
      name = this.state.type.keyword;

      // `class` and `function` keywords push new context into this.context.
      // But there is no chance to pop the context if the keyword is consumed
      // as an identifier such as a property name.
      // If the previous token is a dot, this does not apply because the
      // context-managing code already ignored the keyword
      if (
        (name === "class" || name === "function") &&
        (this.state.lastTokEnd !== this.state.lastTokStart + 1 ||
          this.input.charCodeAt(this.state.lastTokStart) !== charCodes.dot)
      ) {
        this.state.context.pop();
      }
    } else {
      throw this.unexpected();
    }

    if (!liberal) {
      this.checkReservedWord(
        name,
        this.state.start,
        !!this.state.type.keyword,
        false,
      );
    }

    this.next();

    return name;
  }

  checkReservedWord(
    word: string,
    startLoc: number,
    checkKeywords: boolean,
    isBinding: boolean,
  ): void {
    if (this.scope.inGenerator && word === "yield") {
      this.raise(
        startLoc,
        "Can not use 'yield' as identifier inside a generator",
      );
    }

    if (this.scope.inAsync && word === "await") {
      this.raise(
        startLoc,
        "Can not use 'await' as identifier inside an async function",
      );
    }

    if (this.state.inClassProperty && word === "arguments") {
      this.raise(
        startLoc,
        "'arguments' is not allowed in class field initializer",
      );
    }
    if (checkKeywords && isKeyword(word)) {
      this.raise(startLoc, `Unexpected keyword '${word}'`);
    }

    const reservedTest = !this.state.strict
      ? isReservedWord
      : isBinding
      ? isStrictBindReservedWord
      : isStrictReservedWord;

    if (reservedTest(word, this.inModule)) {
      if (!this.scope.inAsync && word === "await") {
        this.raise(
          startLoc,
          "Can not use keyword 'await' outside an async function",
        );
      }
      this.raise(startLoc, `Unexpected reserved word '${word}'`);
    }
  }

  // Parses await expression inside async function.

  parseAwait(): N.AwaitExpression {
    if (!this.state.awaitPos) {
      this.state.awaitPos = this.state.start;
    }
    const node = this.startNode();

    this.next();

    if (this.state.inParameters) {
      this.raise(
        node.start,
        "await is not allowed in async function parameters",
      );
    }
    if (this.match(tt.star)) {
      this.raise(
        node.start,
        "await* has been removed from the async functions proposal. Use Promise.all() instead.",
      );
    }

    if (!this.state.soloAwait) {
      node.argument = this.parseMaybeUnary();
    }
    return this.finishNode(node, "AwaitExpression");
  }

  // Parses yield expression inside generator.

  parseYield(noIn?: ?boolean): N.YieldExpression {
    if (!this.state.yieldPos) {
      this.state.yieldPos = this.state.start;
    }
    const node = this.startNode();

    if (this.state.inParameters) {
      this.raise(node.start, "yield is not allowed in generator parameters");
    }

    this.next();
    if (
      this.match(tt.semi) ||
      (!this.match(tt.star) && !this.state.type.startsExpr) ||
      this.canInsertSemicolon()
    ) {
      node.delegate = false;
      node.argument = null;
    } else {
      node.delegate = this.eat(tt.star);
      node.argument = this.parseMaybeAssign(noIn);
    }
    return this.finishNode(node, "YieldExpression");
  }

  // Validates a pipeline (for any of the pipeline Babylon plugins) at the point
  // of the infix operator `|>`.

  checkPipelineAtInfixOperator(left: N.Expression, leftStartPos: number) {
    if (this.getPluginOption("pipelineOperator", "proposal") === "smart") {
      if (left.type === "SequenceExpression") {
        // Ensure that the pipeline head is not a comma-delimited
        // sequence expression.
        throw this.raise(
          leftStartPos,
          `Pipeline head should not be a comma-separated sequence expression`,
        );
      }
    }
  }

  parseSmartPipelineBody(
    childExpression: N.Expression,
    startPos: number,
    startLoc: Position,
  ): N.PipelineBody {
    const pipelineStyle = this.checkSmartPipelineBodyStyle(childExpression);

    this.checkSmartPipelineBodyEarlyErrors(
      childExpression,
      pipelineStyle,
      startPos,
    );

    return this.parseSmartPipelineBodyInStyle(
      childExpression,
      pipelineStyle,
      startPos,
      startLoc,
    );
  }

  checkSmartPipelineBodyEarlyErrors(
    childExpression: N.Expression,
    pipelineStyle: N.PipelineStyle,
    startPos: number,
  ): void {
    if (this.match(tt.arrow) || this.match(tt.singleArrow)) {
      // If the following token is invalidly `=>`, then throw a human-friendly error
      // instead of something like 'Unexpected token, expected ";"'.
      throw this.raise(
        this.state.start,
        `Unexpected arrow "=>" after pipeline body; arrow function in pipeline body must be parenthesized`,
      );
    } else if (
      pipelineStyle === "PipelineTopicExpression" &&
      childExpression.type === "SequenceExpression"
    ) {
      throw this.raise(
        startPos,
        `Pipeline body may not be a comma-separated sequence expression`,
      );
    }
  }

  parseSmartPipelineBodyInStyle(
    childExpression: N.Expression,
    pipelineStyle: N.PipelineStyle,
    startPos: number,
    startLoc: Position,
  ): N.PipelineBody {
    const bodyNode = this.startNodeAt(startPos, startLoc);
    switch (pipelineStyle) {
      case "PipelineBareFunction":
        bodyNode.callee = childExpression;
        break;
      case "PipelineBareConstructor":
        bodyNode.callee = childExpression.callee;
        break;
      case "PipelineBareAwaitedFunction":
        bodyNode.callee = childExpression.argument;
        break;
      case "PipelineTopicExpression":
        if (!this.topicReferenceWasUsedInCurrentTopicContext()) {
          throw this.raise(
            startPos,
            `Pipeline is in topic style but does not use topic reference`,
          );
        }
        bodyNode.expression = childExpression;
        break;
      default:
        throw this.raise(startPos, `Unknown pipeline style ${pipelineStyle}`);
    }
    return this.finishNode(bodyNode, pipelineStyle);
  }

  checkSmartPipelineBodyStyle(expression: N.Expression): N.PipelineStyle {
    switch (expression.type) {
      default:
        return this.isSimpleReference(expression)
          ? "PipelineBareFunction"
          : "PipelineTopicExpression";
    }
  }

  isSimpleReference(expression: N.Expression): boolean {
    switch (expression.type) {
      case "MemberExpression":
        return (
          !expression.computed && this.isSimpleReference(expression.object)
        );
      case "Identifier":
        return true;
      default:
        return false;
    }
  }

  // Enable topic references from outer contexts within smart pipeline bodies.
  // The function modifies the parser's topic-context state to enable or disable
  // the use of topic references with the smartPipelines plugin. They then run a
  // callback, then they reset the parser to the old topic-context state that it
  // had before the function was called.

  withTopicPermittingContext<T>(callback: () => T): T {
    const outerContextTopicState = this.state.topicContext;
    this.state.topicContext = {
      // Enable the use of the primary topic reference.
      maxNumOfResolvableTopics: 1,
      // Hide the use of any topic references from outer contexts.
      maxTopicIndex: null,
    };

    try {
      return callback();
    } finally {
      this.state.topicContext = outerContextTopicState;
    }
  }

  // Disable topic references from outer contexts within syntax constructs
  // such as the bodies of iteration statements.
  // The function modifies the parser's topic-context state to enable or disable
  // the use of topic references with the smartPipelines plugin. They then run a
  // callback, then they reset the parser to the old topic-context state that it
  // had before the function was called.

  withTopicForbiddingContext<T>(callback: () => T): T {
    const outerContextTopicState = this.state.topicContext;
    this.state.topicContext = {
      // Disable the use of the primary topic reference.
      maxNumOfResolvableTopics: 0,
      // Hide the use of any topic references from outer contexts.
      maxTopicIndex: null,
    };

    try {
      return callback();
    } finally {
      this.state.topicContext = outerContextTopicState;
    }
  }

  withSoloAwaitPermittingContext<T>(callback: () => T): T {
    const outerContextSoloAwaitState = this.state.soloAwait;
    this.state.soloAwait = true;

    try {
      return callback();
    } finally {
      this.state.soloAwait = outerContextSoloAwaitState;
    }
  }

  // Register the use of a primary topic reference (`#`) within the current
  // topic context.
  registerTopicReference(): void {
    this.state.topicContext.maxTopicIndex = 0;
  }

  primaryTopicReferenceIsAllowedInCurrentTopicContext(): boolean {
    return this.state.topicContext.maxNumOfResolvableTopics >= 1;
  }

  topicReferenceWasUsedInCurrentTopicContext(): boolean {
    return (
      this.state.topicContext.maxTopicIndex != null &&
      this.state.topicContext.maxTopicIndex >= 0
    );
  }

  parseFSharpPipelineBody(prec: number, noIn: ?boolean): N.Expression {
    const startPos = this.state.start;
    const startLoc = this.state.startLoc;

    this.state.potentialArrowAt = this.state.start;
    const oldInFSharpPipelineDirectBody = this.state.inFSharpPipelineDirectBody;
    this.state.inFSharpPipelineDirectBody = true;

    const ret = this.parseExprOp(
      this.parseMaybeUnary(),
      startPos,
      startLoc,
      prec,
      noIn,
    );

    this.state.inFSharpPipelineDirectBody = oldInFSharpPipelineDirectBody;

    return ret;
  }
}
