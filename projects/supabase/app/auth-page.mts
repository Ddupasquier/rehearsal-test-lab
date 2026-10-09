const escapeJsonForHtml = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c");

export const renderAuthPage = ({
  supabaseUrl,
  anonKey,
}: {
  supabaseUrl: string;
  anonKey: string;
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rehearsal Test Lab · Authentication</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d171d; color: #e8f6ef; }
      main { width: min(42rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #355463; border-radius: 1.25rem; background: #14242d; box-shadow: 0 1.5rem 5rem #0008; }
      h1 { margin: 0 0 .35rem; font-size: clamp(2rem, 7vw, 3.5rem); letter-spacing: -.05em; }
      h1 span { color: #65d6a8; }
      p { color: #b8ccd4; line-height: 1.55; }
      .providers, form, .session { display: grid; gap: .75rem; margin-top: 1.25rem; }
      .providers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      label { display: grid; gap: .35rem; font-weight: 650; }
      input, button { min-height: 2.8rem; border-radius: .7rem; border: 1px solid #4c6874; font: inherit; }
      input { padding: 0 .8rem; background: #0d171d; color: inherit; }
      button { padding: .65rem 1rem; background: #65d6a8; color: #092118; font-weight: 750; cursor: pointer; }
      button.secondary { background: transparent; color: #e8f6ef; }
      button:focus-visible, input:focus-visible { outline: 3px solid #9df1cf; outline-offset: 2px; }
      .actions { display: flex; flex-wrap: wrap; gap: .75rem; }
      #status { min-height: 1.5rem; padding: .75rem; border-radius: .7rem; background: #0d171d; white-space: pre-wrap; }
      .eyebrow { margin: 0; color: #65d6a8; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      .note { font-size: .9rem; }
      [hidden] { display: none !important; }
      @media (max-width: 34rem) { .providers { grid-template-columns: 1fr; } main { padding: 1.25rem; } }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Local authentication lab</p>
      <h1>Sign in to <span>Rehearsal</span></h1>
      <p>Use a synthetic local account or a reviewed OAuth provider. This page talks only to the disposable local Supabase Auth service.</p>

      <div class="providers" aria-label="OAuth providers">
        <button type="button" data-provider="google">Continue with Google</button>
        <button type="button" data-provider="github">Continue with GitHub</button>
      </div>

      <form id="email-form">
        <label>Email <input id="email" type="email" autocomplete="email" required /></label>
        <label>Password <input id="password" type="password" autocomplete="current-password" minlength="8" /></label>
        <div class="actions">
          <button type="submit">Sign in with email</button>
          <button class="secondary" id="magic-link" type="button">Send local magic link</button>
        </div>
      </form>

      <section class="session" aria-live="polite">
        <strong>Session status</strong>
        <div id="status">Not signed in.</div>
        <div class="actions">
          <button class="secondary" id="refresh" type="button" hidden>Refresh session</button>
          <button class="secondary" id="sign-out" type="button" hidden>Sign out</button>
        </div>
      </section>
      <p class="note">OAuth passwords, passkeys, MFA secrets, cookies, and provider tokens are handled by the provider and local Auth service—not Rehearsal.</p>
    </main>

    <script>
      const config = ${escapeJsonForHtml({ supabaseUrl, anonKey })};
      const storageKey = "rehearsal-test-lab-auth-session";
      const status = document.querySelector("#status");
      const refreshButton = document.querySelector("#refresh");
      const signOutButton = document.querySelector("#sign-out");
      const authHeaders = { apikey: config.anonKey, "content-type": "application/json" };
      let session = null;

      const show = (message, signedIn = false) => {
        status.textContent = message;
        refreshButton.hidden = !signedIn;
        signOutButton.hidden = !signedIn;
      };
      const save = (next) => {
        session = next;
        if (next) localStorage.setItem(storageKey, JSON.stringify(next));
        else localStorage.removeItem(storageKey);
      };
      const request = async (path, options = {}) => {
        const response = await fetch(config.supabaseUrl + "/auth/v1" + path, {
          ...options,
          headers: { ...authHeaders, ...(options.headers || {}) },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.msg || body.message || body.error_description || "Authentication request failed.");
        return body;
      };
      const describeUser = async () => {
        if (!session?.access_token) return show("Not signed in.");
        const user = await request("/user", { headers: { authorization: "Bearer " + session.access_token } });
        show("Signed in locally with " + (user.app_metadata?.provider || "email") + ".\\nVerified account: " + (user.email_confirmed_at ? "yes" : "no"), true);
      };

      const initialize = async () => {
        const query = new URLSearchParams(location.search);
        const callbackError = query.get("error_description");
        if (callbackError) throw new Error("Provider sign-in failed: " + callbackError);

        const tokenHash = query.get("token_hash");
        if (tokenHash) {
          const type = query.get("type") || "magiclink";
          const next = await request("/verify", {
            method: "POST",
            body: JSON.stringify({ token_hash: tokenHash, type }),
          });
          save(next);
          history.replaceState({}, "", location.pathname);
        } else {
          const callback = new URLSearchParams(location.hash.slice(1));
          if (callback.get("access_token")) {
            save({
              access_token: callback.get("access_token"),
              refresh_token: callback.get("refresh_token"),
              expires_in: Number(callback.get("expires_in") || 0),
            });
            history.replaceState({}, "", location.pathname);
          } else {
            try { save(JSON.parse(localStorage.getItem(storageKey))); } catch { save(null); }
          }
        }
        await describeUser();
      };
      initialize().catch((error) => { save(null); show(error.message); });

      document.querySelectorAll("[data-provider]").forEach((button) => {
        button.addEventListener("click", () => {
          const provider = button.dataset.provider;
          const redirect = location.origin + "/auth";
          location.assign(config.supabaseUrl + "/auth/v1/authorize?provider=" + encodeURIComponent(provider) + "&redirect_to=" + encodeURIComponent(redirect));
        });
      });
      document.querySelector("#email-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        show("Signing in…");
        try {
          const next = await request("/token?grant_type=password", {
            method: "POST",
            body: JSON.stringify({ email: document.querySelector("#email").value, password: document.querySelector("#password").value }),
          });
          save(next); await describeUser();
        } catch (error) { show(error.message); }
      });
      document.querySelector("#magic-link").addEventListener("click", async () => {
        show("Requesting a local magic link…");
        try {
          await request("/otp?redirect_to=" + encodeURIComponent(location.origin + "/auth"), {
            method: "POST",
            body: JSON.stringify({ email: document.querySelector("#email").value, create_user: false }),
          });
          show("Magic link sent to the local Mailpit inbox.");
        } catch (error) { show(error.message); }
      });
      refreshButton.addEventListener("click", async () => {
        show("Refreshing…");
        try {
          const next = await request("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: session.refresh_token }) });
          save(next); await describeUser();
        } catch (error) { save(null); show(error.message); }
      });
      signOutButton.addEventListener("click", async () => {
        try { await request("/logout", { method: "POST", headers: { authorization: "Bearer " + session.access_token } }); } catch {}
        save(null); show("Signed out. Local database data was not changed.");
      });
    </script>
  </body>
</html>`;
