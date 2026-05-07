const T = require("tree-sitter-typescript");
console.log("keys:", Object.keys(T));
console.log("typescript typeof:", typeof T.typescript);
console.log("tsx typeof:", typeof T.tsx);
console.log(
  "typescript.query typeof:",
  T.typescript && typeof T.typescript.query,
);
console.log("typescript.query exists:", !!(T.typescript && T.typescript.query));
console.log("typescript.toString:", String(T.typescript).slice(0, 200));

const Parser = require("tree-sitter");
const p = new Parser();
try {
  p.setLanguage(T.typescript);
  console.log("setLanguage OK");
} catch (e) {
  console.error("setLanguage error:", e);
}
