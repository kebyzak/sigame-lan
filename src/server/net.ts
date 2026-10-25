// LAN address discovery.
import os from 'node:os';

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|lo|tun|tap|wg|zt|tailscale|utun|llw|awdl|bridge)/i;

function rank(address: string, iface: string): number {
  let r = 0;
  if (address.startsWith('192.168.')) r += 30;
  else if (address.startsWith('10.')) r += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) r += 10;
  if (/^(wl|wlan|wi-?fi|en|eth)/i.test(iface)) r += 5;
  if (VIRTUAL_IFACE.test(iface)) r -= 100;
  return r;
}

export function lanAddresses(): { address: string; iface: string }[] {
  const out: { address: string; iface: string; r: number }[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, iface, r: rank(a.address, iface) });
    }
  }
  return out.sort((a, b) => b.r - a.r).map(({ address, iface }) => ({ address, iface }));
}

export function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}
