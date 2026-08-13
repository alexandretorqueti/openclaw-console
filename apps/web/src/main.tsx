import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BibliotecaThemeProvider } from "@alexandretorqueti/biblioteca-global-ui";
import { ensureToken } from "./auth";
import "./styles.css";

// O SPA gerencia o próprio scroll (restauração por sessão + autoscroll): desativa a
// restauração nativa do browser para ela não sobrescrever a posição após reload (Ctrl+Shift+R).
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// Diagnóstico: qualquer erro fatal fica visível na tela em vez de "tela azul vazia" sem rastro.
function showFatalError(label: string, error: unknown) {
  const pre = document.createElement("pre");
  pre.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:45vh;overflow:auto;margin:0;background:rgba(120,10,20,.96);color:#fff;padding:14px 16px;z-index:10001;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word";
  pre.textContent = `[${label}] ${error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)}`;
  document.body.appendChild(pre);
}
window.addEventListener("error", (event) => showFatalError("error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => showFatalError("unhandledrejection", event.reason));

// Acesso restrito: o App (e o client da API) só carregam depois de um token válido,
// para que o client seja construído já com o Authorization correto. Se o token
// salvo foi revogado/expirou, o ensureToken limpa e exibe a tela de login.
async function bootstrap() {
  await ensureToken();
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BibliotecaThemeProvider initialTheme="escuro">
        <App />
      </BibliotecaThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
