import { Injectable, inject, signal } from '@angular/core';
import { FirebaseService } from './firebase.service';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShiftConfig {
  hepatitisTeam: string;
  inpatientTeams: string[];
  inpatientCapacity: Record<string, number>;
  regularTeams: string[];
}

export interface EarlyShiftConfig extends ShiftConfig {
  leaderTeam: string;
  leaderThreshold: number;
  leaderCapacity: number;
}

export interface AutoAssignConfig {
  earlyShift: EarlyShiftConfig;
  lateShift: ShiftConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaultAutoAssignConfig(): AutoAssignConfig {
  return {
    earlyShift: {
      hepatitisTeam: 'G',
      inpatientTeams: ['H', 'I', 'J'],
      inpatientCapacity: { H: 2, I: 2, J: 2 },
      leaderTeam: 'A',
      leaderThreshold: 40,
      leaderCapacity: 2,
      regularTeams: ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'],
    },
    lateShift: {
      hepatitisTeam: 'F',
      inpatientTeams: ['H'],
      inpatientCapacity: { H: 2 },
      regularTeams: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    },
  };
}

// ---------------------------------------------------------------------------
// All possible team letters
// ---------------------------------------------------------------------------

export const ALL_TEAM_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DOC_PATH = 'auto_assign_config';
const DOC_ID = 'current';

@Injectable({ providedIn: 'root' })
export class AutoAssignConfigService {
  private readonly firebase = inject(FirebaseService);

  readonly config = signal<AutoAssignConfig>(getDefaultAutoAssignConfig());
  readonly isLoaded = signal(false);

  async fetchConfig(): Promise<AutoAssignConfig> {
    try {
      const ref = doc(this.firebase.db, DOC_PATH, DOC_ID);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const data = snap.data() as AutoAssignConfig;
        // Merge with defaults to ensure all fields exist
        const merged = this.mergeWithDefaults(data);
        this.config.set(merged);
        this.isLoaded.set(true);
        return merged;
      }
    } catch (err) {
      console.error('[AutoAssignConfig] Failed to fetch config:', err);
    }
    const defaults = getDefaultAutoAssignConfig();
    this.config.set(defaults);
    this.isLoaded.set(true);
    return defaults;
  }

  async saveConfig(config: AutoAssignConfig): Promise<void> {
    const ref = doc(this.firebase.db, DOC_PATH, DOC_ID);
    await setDoc(ref, {
      ...config,
      updatedAt: serverTimestamp(),
    });
    this.config.set(config);
  }

  private mergeWithDefaults(data: any): AutoAssignConfig {
    const defaults = getDefaultAutoAssignConfig();
    return {
      earlyShift: {
        hepatitisTeam: data.earlyShift?.hepatitisTeam ?? defaults.earlyShift.hepatitisTeam,
        inpatientTeams: data.earlyShift?.inpatientTeams ?? defaults.earlyShift.inpatientTeams,
        inpatientCapacity: data.earlyShift?.inpatientCapacity ?? defaults.earlyShift.inpatientCapacity,
        leaderTeam: data.earlyShift?.leaderTeam ?? defaults.earlyShift.leaderTeam,
        leaderThreshold: data.earlyShift?.leaderThreshold ?? defaults.earlyShift.leaderThreshold,
        leaderCapacity: data.earlyShift?.leaderCapacity ?? defaults.earlyShift.leaderCapacity,
        regularTeams: data.earlyShift?.regularTeams ?? defaults.earlyShift.regularTeams,
      },
      lateShift: {
        hepatitisTeam: data.lateShift?.hepatitisTeam ?? defaults.lateShift.hepatitisTeam,
        inpatientTeams: data.lateShift?.inpatientTeams ?? defaults.lateShift.inpatientTeams,
        inpatientCapacity: data.lateShift?.inpatientCapacity ?? defaults.lateShift.inpatientCapacity,
        regularTeams: data.lateShift?.regularTeams ?? defaults.lateShift.regularTeams,
      },
    };
  }
}
