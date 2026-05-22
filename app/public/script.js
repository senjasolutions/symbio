const form = document.querySelector("#onboarding-form");
const result = document.querySelector("#result");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  result.textContent = "Saving setup...";
  result.classList.add("is-visible");

  try {
    const response = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Setup failed");
    }

    result.textContent = JSON.stringify(
      {
        status: "onboarding_saved",
        site: payload.config.siteName,
        mode: payload.config.mode,
        automationLevel: payload.config.automationLevel,
        protectedZonesLocked: payload.config.protectedZonesLocked,
        openRouterKeyProvided: payload.config.openRouterKeyProvided,
      },
      null,
      2
    );
  } catch (error) {
    result.textContent = `Setup failed: ${error.message}`;
  }
});

