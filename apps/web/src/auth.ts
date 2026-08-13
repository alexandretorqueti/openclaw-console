export const API_BASE_URL = "https://openclaw-api.webconnect.com.br/api";

const TOKEN_KEY = "open…oken";

export const getStoredToken = (): string | undefined => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const storeToken = (token: string): void => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage indisponível */
  }
};

export const clearToken = (): void => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
};

export const validateToken = async (token: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
    
    const response = await fetch(`${API_BASE_URL}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
};

/** Resolve quando houver um token válido salvo (exibindo a tela de login se necessário). */
export async function ensureToken(): Promise<void> {
  const existing = getStoredToken();
  if (existing && (await validateToken(existing))) return;
  if (existing) clearToken();
  await promptForToken();
}

function promptForToken(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:9999", "display:flex",
      "align-items:center", "justify-content:center",
      "background:radial-gradient(circle at 72% -20%, rgba(105,88,235,.14), transparent 34%), #0b1020",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    ].join(";");

    const card = document.createElement("form");
    card.style.cssText = [
      "width:min(380px, calc(100vw - 40px))", "background:rgba(20,26,46,.9)",
      "border:1px solid rgba(130,141,177,.2)", "border-radius:18px",
      "padding:28px 26px", "box-shadow:0 24px 64px rgba(0,0,0,.5)",
      "display:flex", "flex-direction:column", "gap:14px", "color:#e8ecf7",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "Claw Console";
    title.style.cssText = "font-size:1.15rem;font-weight:700;letter-spacing:.2px";

    const subtitle = document.createElement("div");
    subtitle.textContent = "Acesso restrito. Informe o token de acesso para continuar.";
    subtitle.style.cssText = "font-size:.82rem;color:#aab3cf;line-height:1.45";

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "Token de acesso";
    input.style.cssText = [
      "width:100%", "box-sizing:border-box", "padding:12px 14px",
      "border-radius:11px", "border:1px solid rgba(130,141,177,.3)",
      "background:rgba(10,14,28,.6)", "color:#eef1f9", "font-size:.9rem",
      "outline:none",
    ].join(";");

    const error = document.createElement("div");
    error.style.cssText = "font-size:.78rem;color:#ff8f8f;min-height:1em;display:none";

    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Entrar";
    button.style.cssText = [
      "padding:12px 16px", "border-radius:11px", "border:none", "cursor:pointer",
      "background:#6d5be1", "color:#fff", "font-weight:600", "font-size:.9rem",
    ].join(";");

    card.append(title, subtitle, input, error, button);
    overlay.append(card);
    document.body.append(overlay);
    input.focus();

    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      button.disabled = true;
      button.textContent = "Validando…";
      error.style.display = "none";
      const ok = await validateToken(token);
      if (ok) {
        storeToken(token);
        overlay.remove();
        resolve();
        return;
      }
      button.disabled = false;
      button.textContent = "Entrar";
      error.textContent = "Token inválido. Verifique e tente novamente.";
      error.style.display = "block";
      input.select();
    });
  });
}
