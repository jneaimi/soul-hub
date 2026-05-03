/** Route registry — pulls the routes section out of the loaded config and
 *  exposes lookup helpers. Loads once at startup; the existing config
 *  module already revalidates on POST /api/settings, so a future routes
 *  edit triggers a process restart (same lifecycle as paths/server). */

import { config } from '../config.js';
import { RouteNotFoundError } from './errors.js';
import type { RouteConfig } from './types.js';

const routes = new Map<string, RouteConfig>(Object.entries(config.routes ?? {}));

export function getRoute(name: string): RouteConfig {
	const route = routes.get(name);
	if (!route) throw new RouteNotFoundError(name);
	return route;
}

export function hasRoute(name: string): boolean {
	return routes.has(name);
}

export function listRoutes(): Array<{ name: string; config: RouteConfig }> {
	return Array.from(routes.entries()).map(([name, config]) => ({ name, config }));
}

export function listRouteNames(): string[] {
	return Array.from(routes.keys());
}
