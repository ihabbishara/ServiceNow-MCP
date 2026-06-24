/** A one-shot chat completion used for the crawl relevance/link verdict. */
export interface ChatModel {
  chat(prompt: string): Promise<string>;
}
