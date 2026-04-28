import { useState } from "react";

interface HelloWorldProps {
  name?: string;
}

export default function HelloWorld({ name = "world" }: HelloWorldProps) {
  const [count, setCount] = useState(0);

  return (
    <div className="card" style={{ marginTop: "var(--s-7)" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--aqua-500)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: "var(--s-3)",
        }}
      >
        React island
      </div>
      <h3
        style={{
          fontSize: 24,
          fontWeight: 400,
          letterSpacing: "-0.015em",
          color: "var(--ink)",
          margin: "0 0 var(--s-3) 0",
        }}
      >
        Hello, <em
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            color: "var(--aqua-600)",
          }}
        >{name}</em>.
      </h3>
      <p
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--steel)",
          margin: "0 0 var(--s-5) 0",
        }}
      >
        A small interactive component, hydrated on the client. The button below
        is wired to React state.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCount((c) => c + 1)}
        >
          Count is {count}
        </button>
        {count > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setCount(0)}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
