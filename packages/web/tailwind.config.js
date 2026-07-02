// packages/web/tailwind.config.js — tokens copied verbatim from docs/DESIGN.md
export default {
  content: ["./index.html", "./client/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#fbf9f8",
        surface: "#fbf9f8",
        "surface-container-lowest": "#ffffff",
        "surface-container": "#f0eded",
        "surface-container-high": "#eae8e7",
        "surface-gray": "#F0F0F0",
        "on-surface": "#1b1c1c",
        "on-surface-variant": "#5a4137",
        outline: "#8f7065",
        "outline-variant": "#e3bfb1",
        primary: "#a53d00",
        "on-primary": "#ffffff",
        "primary-container": "#ff6200",
        "on-primary-container": "#541b00",
        secondary: "#57569f",
        "deep-indigo": "#525199",
        "on-secondary": "#ffffff",
        "secondary-container": "#b0aefe",
        error: "#ba1a1a",
        "on-error": "#ffffff",
        "error-container": "#ffdad6",
        "on-error-container": "#93000a",
        success: "#386a20",
        "on-success": "#ffffff",
        "success-container": "#b7f397",
        "on-success-container": "#042100"
      },
      fontFamily: {
        sans: ['"Hanken Grotesk Variable"', '"Hanken Grotesk"', "system-ui", "sans-serif"],
        display: [
          '"Bricolage Grotesque Variable"',
          '"Bricolage Grotesque"',
          "system-ui",
          "sans-serif"
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      fontSize: {
        "display-lg": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "700" }],
        "headline-lg": ["32px", { lineHeight: "40px", fontWeight: "700" }],
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600" }],
        "body-lg": ["18px", { lineHeight: "28px" }],
        "body-md": ["16px", { lineHeight: "24px" }],
        "label-md": ["14px", { lineHeight: "20px", letterSpacing: "0.01em", fontWeight: "600" }],
        "label-sm": ["12px", { lineHeight: "16px", fontWeight: "500" }]
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        sm: "0.125rem",
        md: "0.375rem",
        lg: "0.5rem",
        xl: "0.75rem"
      },
      maxWidth: { container: "1200px" },
      boxShadow: { ambient: "0 8px 30px rgba(0,0,0,0.08)" } // DESIGN.md: soft diffuse, floating only
    }
  },
  plugins: []
};
