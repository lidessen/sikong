import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownMessage(props: { text: string; compact?: boolean }) {
  const compact = props.compact ?? false;
  return (
    <div
      className={`min-w-0 ${compact ? "space-y-2 text-[12px] leading-5" : "space-y-3 leading-6"}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p
              className={`min-w-0 break-words [overflow-wrap:anywhere] ${compact ? "leading-5" : "leading-6"}`}
            >
              {children}
            </p>
          ),
          a: ({ children, href }) => (
            <a
              className="text-primary underline underline-offset-2 hover:text-foreground"
              href={href}
              rel="noreferrer"
              target="_blank"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 className={compact ? "text-sm font-semibold" : "text-base font-semibold"}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className={compact ? "text-[13px] font-semibold" : "text-[15px] font-semibold"}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className={compact ? "text-[12px] font-semibold" : "text-sm font-semibold"}>
              {children}
            </h3>
          ),
          ul: ({ children }) => <ul className="ml-4 list-disc [&>li+li]:mt-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal [&>li+li]:mt-1">{children}</ol>,
          li: ({ children }) => (
            <li className="pl-1 [&>input[type=checkbox]]:mr-1.5 [&>input[type=checkbox]]:accent-primary">
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border-strong pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const inline = !className;
            if (inline) {
              return (
                <code className="box-decoration-clone rounded-[var(--radius-sm)] border bg-background px-1 py-[1px] font-mono text-[12px] leading-[1.55] [overflow-wrap:anywhere]">
                  {children}
                </code>
              );
            }
            return <code className={className}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="overflow-auto rounded-[var(--radius-md)] border bg-background p-3 font-mono text-xs leading-5">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto rounded-[var(--radius-md)] border">
              <table className="w-full table-fixed border-collapse text-left text-xs leading-5">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-muted px-2 py-2 align-top font-medium text-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="break-words border-b px-2 py-2 align-top leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {children}
            </td>
          ),
          hr: () => <div className="h-px bg-border" />,
        }}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
