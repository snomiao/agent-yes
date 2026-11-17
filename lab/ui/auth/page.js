import { getSession, safeReturnTo, signInWithGoogle, signOut } from "./profile.js";

const button = document.getElementById("google-signin");
const label = document.getElementById("google-label");
const status = document.getElementById("auth-status");
const signout = document.getElementById("page-signout");
const params = new URLSearchParams(location.search);
const returnTo = safeReturnTo(params.get("returnTo"));
document.getElementById("continue").href = returnTo;

async function refresh() {
  try {
    const session = await getSession();
    const signedIn = Boolean(session);
    document.getElementById("signed-out").hidden = signedIn;
    document.getElementById("signed-in").hidden = !signedIn;
    document.title = signedIn ? "Your profile · agent-yes" : "Sign in · agent-yes";
    if (session) {
      document.getElementById("profile-name").textContent = session.user.name || "Welcome back.";
      document.getElementById("profile-email").textContent = session.user.email || "";
    }
    label.textContent = "Continue with Google";
    button.disabled = false;
    signout.disabled = false;
    signout.textContent = "Sign out of this account";
  } catch (error) {
    status.textContent = error.message;
    label.textContent = "Continue with Google";
    button.disabled = false;
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  label.textContent = "Opening Google…";
  status.textContent = "";
  try {
    await signInWithGoogle(returnTo);
  } catch (error) {
    status.textContent = error.message;
    label.textContent = "Continue with Google";
    button.disabled = false;
  }
});

signout.addEventListener("click", async () => {
  signout.disabled = true;
  signout.textContent = "Signing out…";
  status.textContent = "";
  try {
    await signOut();
  } catch (error) {
    status.textContent = error.message;
    signout.disabled = false;
    signout.textContent = "Sign out of this account";
  }
});

if (params.has("error")) status.textContent = "Sign-in was not completed. Please try again.";
window.addEventListener("ay-auth-changed", refresh);
refresh();
