/** HTTP application checks enforce bounded redirects, time, and response inspection. */

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

/** Tests the validated configuration pattern against an already bounded response body. */
const matchesResponseRegex = (text, expression) => new RegExp(expression, "u").test(text);

/** Reads at most 64 KB so a health endpoint cannot exhaust agent memory. */
const readBoundedText = async (response) => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      break;
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
};

/** Follows a small explicit redirect chain while retaining the final URL. */
const boundedFetch = async (inputUrl, signal) => {
  let url = new URL(inputUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual", signal,
      headers: { "user-agent": "Symbio-Agent/0.1 health-check", accept: "text/html,application/json,text/plain,*/*;q=0.5" },
    });
    if (response.status < 300 || response.status >= 400 || !response.headers.get("location")) return { response, finalUrl: url.toString() };
    if (redirect === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new Error("Too many redirects");
    }
    url = new URL(response.headers.get("location"), url);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
      await response.body?.cancel();
      throw new Error("Redirect target is not an allowed HTTP URL");
    }
    await response.body?.cancel();
  }
  throw new Error("Redirect handling failed");
};

/** Checks one application and maps the documented defaults to up, slow, or down. */
export const probeApplication = async (application) => {
  const startedAt = performance.now();
  try {
    // One signal covers the entire redirect chain so timeout means total check time.
    const signal = AbortSignal.timeout(application.timeoutMs || 5000);
    const { response, finalUrl } = await boundedFetch(application.url, signal);
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const acceptableStatus = response.status >= 200 && response.status <= 399;
    let matches = true;
    if (application.responseTextMatch) matches = matchesResponseRegex(await readBoundedText(response), application.responseTextMatch);
    else await response.body?.cancel();
    if (!acceptableStatus || !matches) {
      return { applicationId: application.id, status: "down", statusCode: response.status, responseTimeMs, finalUrl, failureReason: acceptableStatus ? "Response did not match the required regular expression." : `Unexpected HTTP ${response.status}.` };
    }
    return { applicationId: application.id, status: responseTimeMs >= (application.slowThresholdMs || 1500) ? "slow" : "up", statusCode: response.status, responseTimeMs, finalUrl, failureReason: null };
  } catch (error) {
    return { applicationId: application.id, status: "down", statusCode: null, responseTimeMs: Math.round(performance.now() - startedAt), finalUrl: application.url, failureReason: String(error.message || "Health check failed").slice(0, 500) };
  }
};

/** Checks applications concurrently because each check is independently bounded. */
export const probeApplications = async (applications) => Promise.all(applications.map(probeApplication));
