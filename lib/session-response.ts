// Development servers and expired sign-ins can return HTML instead of API JSON.
// Never display that response body: it may contain internal details.
export async function readSessionResponse<T>(response: Response): Promise<T> {
  if (response.redirected || response.status === 401) throw new Error('Your sign-in expired. Reload the app to sign in again.');
  const text = await response.text();
  let result: unknown;
  try { result = JSON.parse(text); } catch {
    throw new Error(`The coach server returned an unexpected page (HTTP ${response.status}). Reopen the coach using its launcher, then refresh and try again.`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The coach server returned an invalid response. Refresh and try again.');
  if (!response.ok) {
    const error = (result as { error?: unknown }).error;
    throw new Error(typeof error === 'string' ? error : `The coach server could not complete the request (HTTP ${response.status}). Try again.`);
  }
  return result as T;
}
