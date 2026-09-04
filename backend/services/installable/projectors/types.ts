import type { Types } from 'mongoose';

import type { IComponent, IInstallable } from '../../../models/Installable';
import type { IInstallableInstallation } from '../../../models/InstallableInstallation';

export type ProjectionIds = Record<string, Types.ObjectId | string>;

export interface ProjectionContext {
  installation: IInstallableInstallation;
  installable: IInstallable;
  installedBy: Types.ObjectId;
  // A pod is required while creating a pod-scoped projection. Unprojection
  // acts on the recorded projection ID and must not invent a target pod.
  podId?: Types.ObjectId;
  claimId: string;
}

export interface ComponentProjector {
  type: IComponent['type'];
  project(component: IComponent, context: ProjectionContext): Promise<ProjectionIds>;
  unproject(
    component: IComponent,
    context: ProjectionContext,
    projectionIds: ProjectionIds,
  ): Promise<void>;
}
