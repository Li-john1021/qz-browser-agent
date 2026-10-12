const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "log", "ini", "conf", "cfg", "properties",
  "env", "gitignore", "dockerignore", "editorconfig", "npmrc", "yarnrc", "gitattributes",
]);

const CODE_FILE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "astro",
  "py", "pyw", "ipynb", "java", "kt", "kts", "scala", "groovy", "gradle",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "go", "rs", "rb", "php",
  "swift", "m", "mm", "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hrl",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "html", "htm", "css", "scss", "sass", "less",
  "json", "jsonl", "yaml", "yml", "toml", "xml", "svg", "graphql", "gql", "proto",
  "sol", "tf", "tfvars", "dockerfile", "makefile", "mk",
]);

export const CODE_FILENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "podfile", "procfile",
  "jenkinsfile", "justfile", "vagrantfile", "cmakelists.txt",
]);

export function isTextDocumentExtension(ext: string, lowerName = "") {
  const value = String(ext || "").toLowerCase();
  const name = String(lowerName || "").toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(value) || CODE_FILE_EXTENSIONS.has(value) || CODE_FILENAMES.has(name);
}

export function isCodeDocumentExtension(filename = "") {
  const cleanName = String(filename || "").split("?")[0].split("#")[0];
  const lowerName = cleanName.split(/[\\/]/).pop()?.toLowerCase() || "";
  const ext = cleanName.includes(".") ? cleanName.split(".").pop()?.toLowerCase() || "" : lowerName;
  return CODE_FILE_EXTENSIONS.has(ext) || CODE_FILENAMES.has(lowerName);
}

export function isCodeDocumentMime(mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  return /(?:javascript|typescript|json|jsonl|xml|yaml|x-yaml|toml|graphql|sql|shellscript|x-sh|x-python|x-ruby|x-php|x-java-source|x-csrc|x-c\+\+src|x-go|x-rust)/i.test(mime);
}

export function isTextDocumentMime(mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  return mime.startsWith("text/") || isCodeDocumentMime(mime);
}
