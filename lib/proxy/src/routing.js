// Model routing: rewrites the model Claude Code asks for (claude-opus-5-5,
// claude-haiku-4-5-..., ...) into an upstream catalog id (swe-2-max, ...).
//
// Rules come from routes.json, overlaid by CCP_ROUTES_FILE (a JSON file) and
// then CCP_ROUTES (inline JSON). Keys are exact ids or globs with "*"; an
// exact key beats any glob, and among globs the longest pattern wins. A rule
// whose target is "" or the id itself passes the model through unchanged.
// CCP_ROUTING=off disables routing entirely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROUTES = path.join(SRC_DIR, "routes.json");
const DEFAULT_POLICY = path.join(SRC_DIR, "policy.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadRoutes(env = process.env) {
  if (/^(off|0|false)$/i.test(env.CCP_ROUTING || "")) return {};
  const routes = { ...readJson(DEFAULT_ROUTES) };
  if (env.CCP_ROUTES_FILE) Object.assign(routes, readJson(env.CCP_ROUTES_FILE));
  if (env.CCP_ROUTES) Object.assign(routes, JSON.parse(env.CCP_ROUTES));
  return routes;
}

function globToRegExp(glob) {
  const body = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`);
}

// Returns the upstream model id for `requested`. The "[1m]" context suffix
// Claude Code uses in model pickers is not part of any upstream id.
export function routeModel(requested, routes) {
  const model = requested.replace(/\[1m\]$/i, "");
  let target = routes[model];
  if (target === undefined) {
    const glob = Object.keys(routes)
      .filter((k) => k.includes("*") && globToRegExp(k).test(model))
      .sort((a, b) => b.length - a.length)[0];
    if (glob) target = routes[glob];
  }
  return target || model;
}

// ---- allowlist ----
// Applied to the upstream id AFTER routing, so it covers --model, background
// haiku calls, subagents and raw API clients alike. Sources, later wins:
//   policy.json      bundled default (swe-2-* allowed, blocked -> swe-2-high),
//                    used only when CCP_POLICY_FILE is unset or missing
//   CCP_POLICY_FILE  {"allowed": ["swe-2-high", "swe-1-*"], "reroute_blocked_to": "swe-2-high"}
//   CCP_ALLOWED_MODELS="swe-2-high,swe-1-*"   CCP_REROUTE_BLOCKED_TO=swe-2-high
// An empty allowlist allows everything. With no reroute target (or ""),
// blocked requests are rejected.

export function loadPolicy(env = process.env) {
  const file =
    env.CCP_POLICY_FILE && fs.existsSync(env.CCP_POLICY_FILE) ? env.CCP_POLICY_FILE : DEFAULT_POLICY;
  const p = readJson(file);
  let allowed = p.allowed || [];
  let reroute = p.reroute_blocked_to || null;
  if (env.CCP_ALLOWED_MODELS !== undefined)
    allowed = env.CCP_ALLOWED_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.CCP_REROUTE_BLOCKED_TO !== undefined) reroute = env.CCP_REROUTE_BLOCKED_TO.trim() || null;
  const policy = { allowed, reroute };
  if (reroute && allowed.length && !isAllowed(reroute, policy))
    throw new Error(`reroute target ${reroute} is not in the allowlist (${allowed.join(", ")})`);
  return policy;
}

export function isAllowed(model, policy) {
  return !policy.allowed.length || policy.allowed.some((p) => globToRegExp(p).test(model));
}

// Returns { model, blocked }; `model` is null when the request must be rejected.
export function applyPolicy(model, policy) {
  if (isAllowed(model, policy)) return { model, blocked: false };
  return { model: policy.reroute, blocked: true };
}
