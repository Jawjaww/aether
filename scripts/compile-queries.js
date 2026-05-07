const Parser = require("tree-sitter");
const T = require("tree-sitter-typescript");
const lang = T.typescript;
const patterns = {
  imports: `(import_statement source: (string (string_fragment) @source))`,
  exportedFunctions: `(export_statement (function_declaration name: (identifier) @name parameters: (formal_parameters) @params return_type: (type_annotation)? @return))`,
  localFunctions: `(function_declaration name: (identifier) @name parameters: (formal_parameters) @params return_type: (type_annotation)? @return)`,
  exportedArrows: `(export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function parameters: (_) @params return_type: (type_annotation)? @return))))`,
  localArrows: `(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function parameters: (_) @params return_type: (type_annotation)? @return)))`,
  exportedInterfaces: `(export_statement (interface_declaration name: (type_identifier) @name body: (interface_body) @body))`,
  localInterfaces: `(interface_declaration name: (type_identifier) @name body: (interface_body) @body)`,
  exportedTypes: `(export_statement (type_alias_declaration name: (type_identifier) @name value: (_) @body))`,
  localTypes: `(type_alias_declaration name: (type_identifier) @name value: (_) @body)`,
  branches: `[
      (if_statement)
      (ternary_expression)
      (for_statement)
      (for_in_statement)
      (while_statement)
      (do_statement)
      (switch_case)
      (catch_clause)
    ] @branch`,
  hookCalls: `(call_expression function: (identifier) @hook (#match? @hook "^use[A-Z]"))`,
};

for (const [k, p] of Object.entries(patterns)) {
  try {
    const q = new Parser.Query(lang, p);
    console.log(k, "OK");
  } catch (e) {
    console.error(k, "ERROR", e && e.name, e && e.message);
  }
}
