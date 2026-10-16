import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this module rather than the working directory or a moved entrypoint.
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const runtimeDir=path.join(projectRoot,'runtime');
export const exportsDir=path.join(projectRoot,'exports');
export const publicDir=path.join(projectRoot,'public');
export const scriptsDir=path.join(projectRoot,'scripts');
export const verificationDir=path.join(exportsDir,'verification','reports');
export const defaultUsersRoot=path.resolve(projectRoot,'../../work/qq-users');
export const probeWorkspaceDir=path.resolve(projectRoot,'../../work/probe');
