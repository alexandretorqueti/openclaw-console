import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BibliotecaThemeProvider } from "@alexandretorqueti/biblioteca-global-ui";
import { ensureToken, clearToken, validateToken, getStoredToken } from "./auth";
import "./styles.css";

// O SPA gerencia o próprio scroll (restauração por sessão + autoscroll): desativa a
// restauração nativa do browser para ela não sobrescrever a posição após reload (Ctrl+Shift+R).
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// Acesso restrito: o App (e o client da API) só carregam depois de um token válido,
// para que o client seja construído já com o Authorization correto.
// Recupera sessão do servidor com o token atual. Se o token for rejeitado (401),
// limpa e pede um novo — isso evita a "tela azul vazia" no F5 quando o token
// expirou ou foi revogado no servidor.
async function bootstrap() {
  // 1. Se existe token salvo, valida contra o servidor
  const existing = getStoredToken();
  if (existing) {
    const ok = await validateToken(existing);
    if (!ok) {
      clearToken();
      // ensureToken vai pedir um novo token (overlay de login)
      await ensureToken();
    }
  } else {
    // Sem token salvo → pede
    await ensureToken();
  }

  // 2. Carrega e renderiza o App
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
