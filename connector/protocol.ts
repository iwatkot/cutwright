export const CONNECTOR_PROTOCOL = 1;
export const CONNECTOR_PORTS = Array.from({ length: 12 }, (_, i) => 47831 + i);
export const MAX_CONNECTOR_BYTES = 4 * 1024 * 1024;
export type ConnectorClient = 'codex' | 'claude';
export interface ConnectorInfo {
  application: 'cutwright-connector'; protocol: number; version: string;
  client: ConnectorClient; session: string; paired: boolean; port: number;
}
export interface ConnectorRequest { id: string; name: string; args: Record<string, unknown> }

/** Never allow arbitrary web origins, LAN hosts, credentialed URLs or DNS rebinding. */
export function allowedConnectorOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password &&
      (value === 'https://app.cutwright.cc' ||
        ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
