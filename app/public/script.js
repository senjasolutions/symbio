const form = document.querySelector("#onboarding-form");
const result = document.querySelector("#result");
const healthButton = document.querySelector("#health-check-button");
const healthResult = document.querySelector("#health-result");
const capabilitiesButton = document.querySelector("#capabilities-button");
const capabilitiesResult = document.querySelector("#capabilities-result");

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
        accessProfile: payload.config.accessProfile,
        healthPaths: payload.config.healthPaths,
        repoPaths: payload.config.repoPaths,
        logPaths: payload.config.logPaths,
        configPaths: payload.config.configPaths,
        databaseAccess: payload.config.databaseAccess,
        dockerSocketRequested: payload.config.dockerSocketRequested,
        productionMutationImplemented: payload.config.productionMutationImplemented,
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

capabilitiesButton.addEventListener("click", async () => {
  capabilitiesResult.textContent = "Reading configured capabilities...";
  capabilitiesResult.classList.add("is-visible");

  try {
    const response = await fetch("/api/capabilities");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Capabilities are not configured");
    }

    capabilitiesResult.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    capabilitiesResult.textContent = `Capabilities failed: ${error.message}`;
  }
});

healthButton.addEventListener("click", async () => {
  healthResult.textContent = "Checking configured pages...";
  healthResult.classList.add("is-visible");

  try {
    const response = await fetch("/api/health");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Health check failed");
    }

    healthResult.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    healthResult.textContent = `Health check failed: ${error.message}`;
  }
});
