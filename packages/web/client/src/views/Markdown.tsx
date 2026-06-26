// packages/web/client/src/views/Markdown.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Each element styled with ING semantic tokens only (design grep stays clean).
const components: Components = {
  h1: ({ children }) => <h1 className="text-headline-md mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-headline-md mt-4 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-label-md mt-3 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary-container underline">{children}</a>
  ),
  // Destructure node to avoid passing it to the DOM element (react-markdown v9 ExtraProps).
  code: ({ children, node: _node, ...props }) => (
    <code {...props} className="rounded-sm bg-surface-container-high px-1 py-0.5 font-mono text-label-sm">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="rounded bg-surface-container-high p-3 my-2 overflow-x-auto">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-body-md">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => <th className="border border-outline-variant px-3 py-1.5 text-left font-semibold bg-surface-container">{children}</th>,
  td: ({ children }) => <td className="border border-outline-variant px-3 py-1.5 align-top">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown text-body-md text-on-surface">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
