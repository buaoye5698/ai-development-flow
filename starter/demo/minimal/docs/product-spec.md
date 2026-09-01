# Minimal normalization demo specification

> 版本：1.0.0
> 状态：active

## 1. 来源登记

| 来源 ID | 标题 | authority | 路径 |
| --- | --- | --- | --- |
| DEMO-MINIMAL-SPEC | Minimal normalization demo specification | canonical | `docs/product-spec.md` |

## 2. 规范性需求

**REQ-NORM-001（必须｜behavior）** The operation must apply Unicode NFKC normalization, trim surrounding whitespace, and collapse internal Unicode whitespace to one ASCII space.

验收：The same input always produces the same normalized string and preserves letter case.

**REQ-TYPE-001（必须｜safety）** The operation must reject every non-string input with a TypeError.

验收：No implicit string coercion is allowed.

## 3. 验收矩阵

| 验收 ID | 标题 | 通过条件 |
| --- | --- | --- |
| AT-NORM-001 | Normalize a label | Full-width characters become NFKC equivalents; surrounding whitespace is removed; internal whitespace collapses; letter case is unchanged |
| AT-TYPE-001 | Reject invalid input | Every non-string input throws TypeError before normalization |

## 4. 需求追踪

| 需求 ID | 来源 ID | 验收 ID | 决策 ID |
| --- | --- | --- | --- |
| REQ-NORM-001 | DEMO-MINIMAL-SPEC | AT-NORM-001 | — |
| REQ-TYPE-001 | DEMO-MINIMAL-SPEC | AT-TYPE-001 | — |

## 5. 未决决策

当前 demo 没有未决决策。
