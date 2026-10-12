import type { DocumentCodec } from "#sdk/shared/documents";
import { createJsonDocumentCodec } from "./json-document-codec.js";

export default [createJsonDocumentCodec(bytes => new TextDecoder().decode(bytes))] satisfies readonly DocumentCodec[];
