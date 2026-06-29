// packages/web/client/src/views/Login.tsx — device code is the signature focal element
import { startLogin } from "../api.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
export function Login({ deviceCode }: { deviceCode?: { verificationUri: string; userCode: string } }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <Card className="p-10 max-w-md w-full text-center">
        <h1 className="text-headline-lg mb-2">SRE Agent</h1>
        <p className="text-body-md text-on-surface-variant mb-8">Sign in with your GitHub Copilot account to start.</p>
        {deviceCode ? (
          <div>
            <p className="text-label-md text-on-surface-variant mb-3">Enter this code at the verification page:</p>
            <div className="font-mono tabular-nums text-display-lg tracking-[0.15em] text-primary-container mb-6">
              {deviceCode.userCode}
            </div>
            <a
              className="inline-block px-5 py-2.5 rounded bg-primary-container text-on-primary text-label-md"
              href={deviceCode.verificationUri}
              target="_blank"
              rel="noreferrer"
              aria-label="Open verification page (opens in new tab)"
            >
              Open verification page
            </a>
            <p className="text-label-sm text-on-surface-variant mt-4 break-all">{deviceCode.verificationUri}</p>
          </div>
        ) : (
          <Button onClick={() => startLogin()}>Sign in with GitHub Copilot</Button>
        )}
      </Card>
    </div>
  );
}
