import { canonicalTextDigest, digestJson, normalizeRepoPath, sha256 } from "../core/index.mjs";

export const STRUCTURED_MARKDOWN_ADAPTER_ID = "structured-markdown";
export const SPEC_COMPILER_VERSION = "2.0.0";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const REQUIRED_SECTIONS = Object.freeze({
  sources: "来源登记",
  requirements: "规范性需求",
  acceptanceCases: "验收矩阵",
  traceability: "需求追踪",
  decisions: "未决决策",
});

const STRENGTHS = Object.freeze({
  "必须": "must",
  must: "must",
  "应": "should",
  should: "should",
  "可": "may",
  may: "may",
});

const AUTHORITIES = new Set(["canonical", "authoritative_input", "non_authoritative"]);

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function unique(values) {
  return [...new Set(values)];
}

function stripBom(value) {
  return value.replace(/^\uFEFF/u, "");
}

function normalizeHeading(value) {
  return value
    .replace(/^\s*[0-9]+(?:\.[0-9]+)*\.?\s*/u, "")
    .trim();
}

function splitTableRow(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function parseIdList(value) {
  if (!value || /^[—-]$/u.test(value.trim())) return [];
  return unique(
    value
      .replace(/<br\s*\/?>/giu, " ")
      .split(/[\s,，、;；]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function metadataValue(lines, label) {
  const pattern = new RegExp(`^>\\s*${label}[：:]\\s*(.+?)\\s*$`, "u");
  for (const line of lines) {
    const match = pattern.exec(line.text);
    if (match) return match[1];
  }
  return null;
}

function collectSections(lines, errors) {
  const sections = Object.fromEntries(Object.keys(REQUIRED_SECTIONS).map((key) => [key, null]));
  const aliases = new Map(Object.entries(REQUIRED_SECTIONS).map(([key, title]) => [title, key]));

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/u.exec(lines[index].text);
    if (!match) continue;
    const key = aliases.get(normalizeHeading(match[1]));
    if (!key) continue;
    if (sections[key]) {
      errors.push(finding("duplicate_section", `规格章节重复：${REQUIRED_SECTIONS[key]}`, { line: lines[index].line }));
      continue;
    }

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{1,2}\s+/u.test(lines[cursor].text)) {
        end = cursor;
        break;
      }
    }
    sections[key] = { line: lines[index].line, lines: lines.slice(index + 1, end) };
  }

  for (const [key, title] of Object.entries(REQUIRED_SECTIONS)) {
    if (!sections[key]) errors.push(finding("missing_section", `规格缺少章节：${title}`, { section: key }));
  }
  return sections;
}

function tableRows(section) {
  if (!section) return [];
  const rows = [];
  for (const line of section.lines) {
    const cells = splitTableRow(line.text);
    if (!cells || isSeparatorRow(cells)) continue;
    rows.push({ cells, line: line.line });
  }
  return rows;
}

function parseSources(section, errors) {
  const sources = [];
  for (const { cells, line } of tableRows(section)) {
    if (!STABLE_ID.test(cells[0] ?? "")) continue;
    const [id, title, authority, rawPath] = cells;
    if (!title) errors.push(finding("source_title_missing", `来源 ${id} 缺少标题。`, { id, line }));
    if (!AUTHORITIES.has(authority)) {
      errors.push(finding("source_authority_invalid", `来源 ${id} 的 authority 无效。`, { id, line, authority }));
    }
    const normalizedPath = rawPath && !/^[—-]$/u.test(rawPath) ? normalizeRepoPath(rawPath.replace(/^`|`$/gu, "")) : null;
    sources.push({
      id,
      title: title || id,
      authority: AUTHORITIES.has(authority) ? authority : "non_authoritative",
      ...(normalizedPath ? { path: normalizedPath } : {}),
      line,
    });
  }
  return sources;
}

function parseRequirements(lines, errors) {
  const requirements = [];
  const pattern = /^\s*\*\*([A-Za-z0-9][A-Za-z0-9._:-]{1,127})[（(](必须|应|可|must|should|may)[｜|]([^）)]+)[）)]\*\*\s*(.+?)\s*$/iu;

  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index].text);
    if (!match) continue;
    let next = index + 1;
    while (next < lines.length && lines[next].text.trim() === "") next += 1;
    const acceptanceMatch = /^\s*验收[：:]\s*(.+?)\s*$/u.exec(lines[next]?.text ?? "");
    if (!acceptanceMatch) {
      errors.push(finding("requirement_acceptance_missing", `需求 ${match[1]} 后缺少内联验收。`, {
        id: match[1],
        line: lines[index].line,
      }));
    }
    requirements.push({
      id: match[1],
      strength: STRENGTHS[match[2].toLocaleLowerCase("en-US")],
      statement: match[4].trim(),
      ...(acceptanceMatch ? { acceptance: acceptanceMatch[1] } : {}),
      line: lines[index].line,
      attributes: { domain: match[3].trim() },
    });
  }
  return requirements;
}

function splitCriteria(value) {
  return unique(
    String(value ?? "")
      .split(/<br\s*\/?>|[；;]/giu)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseAcceptanceCases(section, errors) {
  const acceptanceCases = [];
  for (const { cells, line } of tableRows(section)) {
    if (!STABLE_ID.test(cells[0] ?? "")) continue;
    const [id, title, criteriaText] = cells;
    const criteria = splitCriteria(criteriaText);
    if (!title) errors.push(finding("acceptance_title_missing", `验收 ${id} 缺少标题。`, { id, line }));
    if (criteria.length === 0) errors.push(finding("acceptance_criteria_missing", `验收 ${id} 缺少通过条件。`, { id, line }));
    acceptanceCases.push({ id, title: title || id, criteria, line });
  }
  return acceptanceCases;
}

function parseTraceability(section) {
  const traceability = [];
  for (const { cells } of tableRows(section)) {
    if (!STABLE_ID.test(cells[0] ?? "")) continue;
    traceability.push({
      requirementId: cells[0],
      sourceIds: parseIdList(cells[1]),
      acceptanceIds: parseIdList(cells[2]),
      decisionIds: parseIdList(cells[3]),
    });
  }
  return traceability;
}

function parseDecisions(section, errors) {
  const decisions = [];
  for (const { cells, line } of tableRows(section)) {
    if (!STABLE_ID.test(cells[0] ?? "")) continue;
    const [id, question, suggestedOwner] = cells;
    if (!question) errors.push(finding("decision_question_missing", `决策 ${id} 缺少问题。`, { id, line }));
    decisions.push({
      id,
      question: question || id,
      ...(suggestedOwner && !/^[—-]$/u.test(suggestedOwner) ? { suggestedOwner } : {}),
      line,
    });
  }
  return decisions;
}

function reportDuplicates(collections, errors) {
  for (const [kind, entries] of Object.entries(collections)) {
    const seen = new Map();
    for (const entry of entries) {
      const lines = seen.get(entry.id) ?? [];
      lines.push(entry.line ?? null);
      seen.set(entry.id, lines);
    }
    for (const [id, lines] of seen) {
      if (lines.length > 1) errors.push(finding("duplicate_id", `${kind} ID 重复：${id}`, { kind, id, lines }));
    }
  }
}

function validateReferences({ sources, requirements, acceptanceCases, decisions, traceability }, errors, warnings) {
  const sourceIds = new Set(sources.map((entry) => entry.id));
  const requirementIds = new Set(requirements.map((entry) => entry.id));
  const acceptanceIds = new Set(acceptanceCases.map((entry) => entry.id));
  const decisionIds = new Set(decisions.map((entry) => entry.id));
  const tracedRequirements = new Set();
  const referencedAcceptances = new Set();

  for (const trace of traceability) {
    if (!requirementIds.has(trace.requirementId)) {
      errors.push(finding("unknown_requirement_reference", `追踪引用未知需求：${trace.requirementId}`, { id: trace.requirementId }));
    }
    if (tracedRequirements.has(trace.requirementId)) {
      errors.push(finding("duplicate_traceability", `需求存在多条追踪记录：${trace.requirementId}`, { id: trace.requirementId }));
    }
    tracedRequirements.add(trace.requirementId);
    if (trace.sourceIds.length === 0) {
      errors.push(finding("trace_source_missing", `追踪未声明来源：${trace.requirementId}`, { id: trace.requirementId }));
    }
    for (const id of trace.sourceIds) {
      if (!sourceIds.has(id)) errors.push(finding("unknown_source_reference", `追踪引用未知来源：${id}`, { id }));
    }
    for (const id of trace.acceptanceIds) {
      referencedAcceptances.add(id);
      if (!acceptanceIds.has(id)) errors.push(finding("unknown_acceptance_reference", `追踪引用未知验收：${id}`, { id }));
    }
    for (const id of trace.decisionIds) {
      if (!decisionIds.has(id)) errors.push(finding("unknown_decision_reference", `追踪引用未知决策：${id}`, { id }));
    }
  }

  for (const id of requirementIds) {
    if (!tracedRequirements.has(id)) errors.push(finding("requirement_not_traced", `需求未进入追踪表：${id}`, { id }));
  }
  for (const id of acceptanceIds) {
    if (!referencedAcceptances.has(id)) warnings.push(finding("acceptance_not_referenced", `验收未被任何需求引用：${id}`, { id }));
  }
}

function assertCompileInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("compile input must be an object");
  for (const key of ["text", "baselineId", "sourceId", "path"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new TypeError(`${key} must be a non-empty string`);
  }
  if (!STABLE_ID.test(input.baselineId) || !STABLE_ID.test(input.sourceId)) throw new TypeError("baselineId and sourceId must be stable IDs");
  const normalizedPath = normalizeRepoPath(input.path);
  if (!normalizedPath || normalizedPath.startsWith("../") || normalizedPath === ".." || /^[A-Za-z]:/u.test(normalizedPath) || normalizedPath.startsWith("/")) {
    throw new TypeError("path must be a repository-relative file path");
  }
  return normalizedPath;
}

export function compileStructuredMarkdown(input) {
  const specPath = assertCompileInput(input);
  const text = stripBom(input.text).replace(/\r\n?/gu, "\n");
  const lines = text.split("\n").map((line, index) => ({ text: line, line: index + 1 }));
  const errors = [];
  const warnings = [];
  const digest = canonicalTextDigest(text);

  if (input.expectedDigest && input.expectedDigest !== digest) {
    errors.push(finding("spec_digest_mismatch", "规格内容摘要与预期基线不一致。", {
      expected: input.expectedDigest,
      actual: digest,
    }));
  }
  if (text.includes("尚未登记。")) errors.push(finding("spec_not_configured", "规格仍包含未配置占位内容。"));

  const sections = collectSections(lines, errors);
  const sources = parseSources(sections.sources, errors);
  const requirements = parseRequirements(sections.requirements?.lines ?? [], errors);
  const acceptanceCases = parseAcceptanceCases(sections.acceptanceCases, errors);
  const decisions = parseDecisions(sections.decisions, errors);
  const traceability = parseTraceability(sections.traceability);

  if (sources.length === 0) errors.push(finding("sources_missing", "未识别到来源登记。"));
  if (requirements.length === 0) errors.push(finding("requirements_missing", "未识别到规范性需求。"));
  if (acceptanceCases.length === 0) errors.push(finding("acceptance_cases_missing", "未识别到验收用例。"));
  if (traceability.length === 0) errors.push(finding("traceability_missing", "未识别到需求追踪。"));

  reportDuplicates({ source: sources, requirement: requirements, acceptance: acceptanceCases, decision: decisions }, errors);
  validateReferences({ sources, requirements, acceptanceCases, decisions, traceability }, errors, warnings);

  const title = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]?.trim() ?? null;
  const version = metadataValue(lines, "版本");
  const status = metadataValue(lines, "状态");
  const sourceDigest = canonicalTextDigest(text);
  const fallbackAdapter = {
    module: "src/spec/structured-markdown.mjs",
    exportName: "compileStructuredMarkdown",
    moduleDigest: sha256("embedded:structured-markdown-v2"),
    configDigest: digestJson({ options: input.options ?? {} }),
  };
  const fallbackFramework = {
    name: "ai-development-flow",
    version: "1.0.0",
  };
  const provenance = input.provenance ?? {
    source: { sourceId: input.sourceId, path: specPath, digest: sourceDigest },
    adapter: fallbackAdapter,
    frameworkDistribution: {
      ...fallbackFramework,
      digest: digestJson({
        frameworkName: fallbackFramework.name,
        frameworkVersion: fallbackFramework.version,
        adapter: {
          module: fallbackAdapter.module,
          exportName: fallbackAdapter.exportName,
          moduleDigest: fallbackAdapter.moduleDigest,
        },
      }),
    },
    baseRevision: "0000000000000000000000000000000000000000",
  };
  const index = {
    schemaVersion: 2,
    compilerVersion: SPEC_COMPILER_VERSION,
    baselineId: input.baselineId,
    provenance,
    spec: {
      sourceId: input.sourceId,
      path: specPath,
      digest,
      ...(title ? { title } : {}),
      ...(version ? { version } : {}),
      ...(status ? { status } : {}),
    },
    sources,
    requirements,
    acceptanceCases,
    decisions,
    traceability,
    integrity: {
      status: errors.length === 0 ? "pass" : "fail",
      errors,
      warnings,
    },
  };
  return index;
}

export function inspectSpecification(text) {
  if (typeof text !== "string") throw new TypeError("specification text must be a string");
  return {
    adapterId: STRUCTURED_MARKDOWN_ADAPTER_ID,
    title: /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? null,
    configured: !text.includes("尚未登记。"),
  };
}
