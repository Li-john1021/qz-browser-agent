import type { Readability } from "@mozilla/readability";

/** Local Content context APIs; these DOM objects never cross runtime messages. */
export type ReadableArticleMetadata = Partial<Pick<NonNullable<ReturnType<Readability["parse"]>>,
  "title" | "byline" | "siteName" | "publishedTime" | "excerpt" | "content" | "textContent">>;
export interface ExtractedArticle {
  name: string; content: string; text: string; metadata?: ReadableArticleMetadata;
}
export interface ArticleExtractor {
  extract(document: Document, options?: { readability?: ReadableArticleMetadata | null; complete?: boolean }): ExtractedArticle | null;
}
