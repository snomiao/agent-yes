// The React example (examples/react) on the dev hub: bundled per request by
// scripts/dev.ts as <BASE>/react.js, opened as <BASE>/react.html.
import { createRoot } from "react-dom/client";
import { HubChat } from "../examples/react/HubChat";

// A runtime URL, as an app loading a hosted liagent.js would use.
const src = new URL("./liagent.js", location.href).href;

createRoot(document.getElementById("root")!).render(
  <HubChat url="./api/chat" load={() => import(/* webpackIgnore: true */ src)} />,
);
