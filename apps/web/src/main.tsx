import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BibliotecaThemeProvider } from "@alexandretorqueti/biblioteca-global-ui";
import { ensureToken } from "./auth";
import "./styles.css";

// O SPA gerencia o próprio scroll (restauração por sessão + autoscroll): desativa a
// restauração nativa do browser para ela não sobrescrever a posição após reload (Ctrl+Shift+R).
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// Acesso restrito: o App (e o client da API) só carregam depois de um token válido,
// para que o client seja construído já com o Authorization correto.
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
