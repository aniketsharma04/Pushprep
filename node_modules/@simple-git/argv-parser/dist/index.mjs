import { isPathSpec as p, toPaths as m } from "@simple-git/args-pathspec";
function* w(e, t) {
  const n = t === "global";
  for (const o of e)
    o.isGlobal === n && (yield o);
}
const x = /* @__PURE__ */ new Set([
  "--add",
  "--edit",
  "--remove-section",
  "--rename-section",
  "--replace-all",
  "--unset",
  "--unset-all",
  "-e"
]), S = /* @__PURE__ */ new Set([
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l"
]), k = /* @__PURE__ */ new Set([
  "edit",
  "remove-section",
  "rename-section",
  "set",
  "unset"
]), y = /* @__PURE__ */ new Set(["get", "get-color", "get-colorbool", "list"]);
function C(e, t) {
  for (const { name: o } of w(e, "task")) {
    if (x.has(o))
      return f(!0, t);
    if (S.has(o))
      return f(!1, t);
  }
  const n = t.at(0)?.toLowerCase();
  return n === void 0 ? null : k.has(n) ? f(!0, t.slice(1)) : y.has(n) ? f(!1, t.slice(1)) : t.length === 1 ? f(!1, t) : f(!0, t);
}
function f(e = !1, t = []) {
  const n = t.at(0)?.toLowerCase();
  return n === void 0 ? null : {
    isWrite: e,
    isRead: !e,
    key: n,
    value: t.at(1)
  };
}
function N(e, t) {
  return t.isWrite && t.value !== void 0 ? { key: t.key, value: t.value, scope: e } : { key: t.key, scope: e };
}
function P(e) {
  const t = e?.indexOf("=") || -1;
  return !e || t < 0 ? null : {
    key: e.slice(0, t).trim().toLowerCase(),
    value: e.slice(t + 1)
  };
}
function U(e) {
  for (const { name: t } of w(e, "task"))
    switch (t) {
      case "--global":
        return "global";
      case "--system":
        return "system";
      case "--worktree":
        return "worktree";
      case "--local":
        return "local";
      case "--file":
      case "-f":
        return "file";
    }
  return "local";
}
function A({ name: e }) {
  if (e === "-c" || e === "--config")
    return "inline";
  if (e === "--config-env")
    return "env";
}
function* F(e) {
  for (const t of e) {
    const n = A(t), o = n && P(t.value);
    o && (yield {
      ...o,
      scope: n
    });
  }
}
function M(e, t, n) {
  const o = {
    read: [],
    write: [...F(t)]
  };
  return e === "config" && G(
    o,
    U(t),
    C(t, n)
  ), o;
}
function G(e, t, n) {
  if (n === null)
    return;
  const o = N(t, n);
  n.isWrite ? e.write.push(o) : e.read.push(o);
}
const v = {
  short: /* @__PURE__ */ new Map([
    ["c", !0]
    //  -c <k=v>    set config key for this invocation
  ])
}, O = {
  short: new Map([
    ["C", !0],
    //  -C <path>   change working directory
    ["P", !1],
    // -P          no pager (alias for --no-pager)
    ["h", !1],
    // -h          help
    ["p", !1],
    // -p          paginate
    ["v", !1],
    // -v          version
    ...v.short.entries()
  ]),
  long: /* @__PURE__ */ new Set([
    "attr-source",
    "config-env",
    "exec-path",
    "git-dir",
    "list-cmds",
    "namespace",
    "super-prefix",
    "work-tree"
  ])
}, E = {
  clone: {
    short: /* @__PURE__ */ new Map([
      ["b", !0],
      // -b <branch>
      ["j", !0],
      // -j <n>          parallel jobs
      ["l", !1],
      // -l local
      ["n", !1],
      // -n no-checkout
      ["o", !0],
      // -o <name>       remote name
      ["q", !1],
      // -q quiet
      ["s", !1],
      // -s shared
      ["u", !0]
      // -u <upload-pack>
    ]),
    long: /* @__PURE__ */ new Set(["branch", "config", "jobs", "origin", "upload-pack", "u"])
  },
  commit: {
    short: /* @__PURE__ */ new Map([
      ["C", !0],
      // -C <commit>  reuse message
      ["F", !0],
      // -F <file>    read message from file
      ["c", !0],
      // -c <commit>  reedit message
      ["m", !0],
      // -m <msg>
      ["t", !0]
      // -t <template>
    ]),
    long: /* @__PURE__ */ new Set(["file", "message", "reedit-message", "reuse-message", "template"])
  },
  config: {
    short: /* @__PURE__ */ new Map([
      ["e", !1],
      // -e  open editor
      ["f", !0],
      //  -f <file>
      ["l", !1]
      // -l  list
    ]),
    long: /* @__PURE__ */ new Set(["blob", "comment", "default", "file", "type", "value"])
  },
  fetch: {
    short: /* @__PURE__ */ new Map(),
    long: /* @__PURE__ */ new Set(["upload-pack"])
  },
  pull: {
    short: /* @__PURE__ */ new Map(),
    long: /* @__PURE__ */ new Set(["upload-pack"])
  },
  push: {
    short: /* @__PURE__ */ new Map(),
    long: /* @__PURE__ */ new Set(["exec", "receive-pack"])
  }
}, I = { short: /* @__PURE__ */ new Map(), long: /* @__PURE__ */ new Set() };
function L(e) {
  const t = E[e ?? ""] ?? I;
  return {
    short: new Map([...v.short.entries(), ...t.short.entries()]),
    long: t.long
  };
}
function b(e, t = O) {
  if (e.startsWith("--")) {
    const n = e.indexOf("=");
    if (n > 2)
      return [{ name: e.slice(0, n), value: e.slice(n + 1), needsNext: !1 }];
    const o = e.slice(2);
    return [{ name: e, needsNext: t.long.has(o) }];
  }
  if (e.length === 2) {
    const n = e.charAt(1), o = t.short.get(n);
    return [{ name: e, needsNext: o === !0 }];
  }
  return R(e, t.short);
}
function R(e, t) {
  const n = e.slice(1).split(""), o = [];
  for (let a = 0; a < n.length; a++) {
    const s = n[a], r = t.get(s);
    if (r === void 0)
      return [{ name: e, needsNext: !1 }];
    if (r) {
      const l = n.slice(a + 1).join("");
      if (l && ![...l].every((h) => t.has(h)))
        return o.push({ name: `-${s}`, value: l, needsNext: !1 }), o;
    }
    o.push({ name: `-${s}`, needsNext: r });
  }
  return o;
}
function W(e, t = []) {
  let n = 0;
  for (; n < e.length; ) {
    const o = String(e[n]);
    if (!o.startsWith("-") || o.length < 2) break;
    const a = b(o);
    let s = n + 1;
    for (const r of a) {
      const l = {
        name: r.name,
        value: r.value,
        absorbedNext: !1,
        isGlobal: !0
      };
      r.needsNext && l.value === void 0 && s < e.length && (l.value = String(e[s]), l.absorbedNext = !0, s++), t.push(l);
    }
    n = s;
  }
  return { flags: t, taskIndex: n };
}
function _(e, t, n = []) {
  const o = L(t), a = [], s = [];
  let r = 0;
  for (; r < e.length; ) {
    const l = e[r];
    if (p(l)) {
      s.push(...m(l)), r++;
      continue;
    }
    const u = String(l);
    if (u === "--") {
      for (let c = r + 1; c < e.length; c++) {
        const i = e[c];
        p(i) ? s.push(...m(i)) : s.push(String(i));
      }
      break;
    }
    if (!u.startsWith("-") || u.length < 2) {
      a.push(u), r++;
      continue;
    }
    const h = b(u, o);
    let d = r + 1;
    for (const c of h) {
      const i = {
        name: c.name,
        value: c.value,
        absorbedNext: !1,
        isGlobal: !1
      };
      c.needsNext && i.value === void 0 && d < e.length && !p(e[d]) && (i.value = String(e[d]), i.absorbedNext = !0, d++), n.push(i);
    }
    r = d;
  }
  return { flags: n, positionals: a, pathspecs: s };
}
function* T({ write: e }) {
  for (const t of e)
    for (const n of $) {
      const o = n(t.key);
      o && (yield o);
    }
}
function g(e, t, n = String(e)) {
  const o = typeof e == "string" ? new RegExp(`\\s*${e}`, "i") : e;
  return function(s) {
    if (o.test(s))
      return {
        category: t,
        message: `Configuring ${n} is not permitted without enabling ${t}`
      };
  };
}
const $ = [
  g(
    /^\s*protocol(.[a-z]+)?.allow/i,
    "allowUnsafeProtocolOverride",
    "protocol.allow"
  ),
  g("core.sshCommand", "allowUnsafeSshCommand"),
  g("core.fsmonitor", "allowUnsafeFsMonitor"),
  g("core.gitProxy", "allowUnsafeGitProxy"),
  g("core.hooksPath", "allowUnsafeHooksPath"),
  g("diff.external", "allowUnsafeDiffExternal")
];
function* j(e, t) {
  for (const n of t)
    /^--(upload|receive)-pack/.test(n.name) && (yield {
      category: "allowUnsafePack",
      message: "Use of --upload-pack or --receive-pack is not permitted without enabling allowUnsafePack"
    }), e === "clone" && (/^-\w*u/.test(n.name) || n.name === "--u") && (yield {
      category: "allowUnsafePack",
      message: "Use of clone with option -u is not permitted without enabling allowUnsafePack"
    }), e === "push" && /^--exec/.test(n.name) && (yield {
      category: "allowUnsafePack",
      message: "Use of push with option --exec is not permitted without enabling allowUnsafePack"
    });
}
function B(e, t, n) {
  const o = [
    ...j(e, t),
    ...T(n)
  ];
  return {
    categories: o.reduce((s, r) => s.add(r.category), /* @__PURE__ */ new Set()),
    vulnerabilities: o
  };
}
function V(...e) {
  const { flags: t, taskIndex: n } = W(e), o = n < e.length ? String(e[n]).toLowerCase() : null, a = o !== null ? e.slice(n + 1) : [], { positionals: s, pathspecs: r } = _(a, o, t), l = M(o, t, s);
  return {
    task: o,
    flags: t.map(D),
    paths: r,
    config: l,
    vulnerabilities: B(o, t, l)
  };
}
function D({ value: e, name: t }) {
  return e !== void 0 ? { name: t, value: e } : { name: t };
}
export {
  V as parseArgv,
  B as vulnerabilityAnalysis
};
//# sourceMappingURL=index.mjs.map
