/**
 * Errors produced by toonarrow itself carry `x-toonarrow-error`: `route` means nothing was forwarded (unknown upstream
 * or path), so a client may safely resend the request directly; `upstream` and `internal` may have been forwarded.
 */
export type ProxyErrorKind = 'route' | 'upstream' | 'internal';

export const proxyError = (message: string) => ({ type: 'error', error: { type: 'toonarrow_proxy_error', message } });
