/**
 * The trust fence for this plugin's HTTP route.
 *
 * The Web GUI is served on loopback and may also be reached through a LAN bind,
 * a reverse proxy or a tunnel, so the route accepts a request only when its
 * `Host` is loopback or an explicitly trusted authority, not a cross-site fetch,
 * and — when an `Origin` is present — same-host. This mirrors the fence the
 * shipped Web routes use; a browser cannot forge these headers from another
 * origin, which is what keeps the route from becoming an open session-path oracle.
 *
 * @module dsh-session-path/trust
 */

/** Case-insensitive header lookup (Node lowercases, fakes may not). */
function headerOf(headers, name) {
	const value = headers?.[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return undefined;
}

/**
 * Hostname only, from a `Host` header value (IPv6 brackets preserved).
 *
 * @param host - the raw header value.
 * @returns the hostname, or null when unparsable.
 */
export function authorityHostname(host) {
	try {
		return new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Whether a hostname is a loopback spelling.
 *
 * @param hostname - lowercased hostname.
 * @returns true for localhost / 127.0.0.0-8 / ::1.
 */
export function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
	return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Whether `Host` matches one of the runtime's trusted authorities.
 *
 * @param host - raw `Host` header value.
 * @param trustedHosts - authorities from the web runtime (`host` or `host:port`).
 * @returns true on an exact authority match.
 */
export function isTrustedAuthority(host, trustedHosts) {
	if (!Array.isArray(trustedHosts)) return false;
	const wanted = host.toLowerCase();
	return trustedHosts.some((entry) => typeof entry === "string" && entry.toLowerCase() === wanted);
}

/**
 * The fence itself.
 *
 * @param request - the HTTP request.
 * @param trustedHosts - authorities from the web runtime.
 * @returns true when the request may read session paths.
 */
export function isTrustedRequest(request, trustedHosts) {
	const host = headerOf(request?.headers, "host");
	if (host === undefined) return false;
	const hostname = authorityHostname(host);
	if (hostname === null) return false;
	if (!isLoopbackHostname(hostname) && !isTrustedAuthority(host, trustedHosts)) return false;
	if (headerOf(request?.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = headerOf(request?.headers, "origin");
	if (origin === undefined) return true;
	try {
		return new URL(origin).hostname.toLowerCase() === hostname;
	} catch {
		return false;
	}
}
