/** Small HTTP helpers every route uses. */
import { messagePage } from './pages.js';

export const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
export const b64 = (o: unknown) => btoa(JSON.stringify(o));
export const unb64 = (s: string) => JSON.parse(atob(s));
export const cookieValue = (r: Request, name: string) => r.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
export const bearer = (r: Request) => r.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
export const plain = (title: string, msg: string, status: number) => html(messagePage(title, msg), status);
export const zone = (r: Request) => ((r as any).cf?.timezone as string | undefined) ?? 'UTC';
