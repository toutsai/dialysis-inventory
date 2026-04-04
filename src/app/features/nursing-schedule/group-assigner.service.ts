/**
 * 護理師組別分配服務
 * Ported from Vue's useGroupAssigner.js composable
 */
import {
  getDefaultConfig,
  generateDayShiftGroups,
  generateNightShiftGroups,
  calculate74Groups,
} from '@/services/nursingGroupConfigService';

export class GroupAssignerService {
  private groupConfig: any;
  private prevMonthSchedule: any;
  private nextMonthSchedule: any;

  constructor(groupConfig: any, prevMonthSchedule: any, nextMonthSchedule: any) {
    this.groupConfig = groupConfig;
    this.prevMonthSchedule = prevMonthSchedule;
    this.nextMonthSchedule = nextMonthSchedule;
  }

  /**
   * Auto-generate group assignments for entire month
   */
  generateGroupAssignments(originalSchedule: any): any {
    if (!originalSchedule) return null;
    const schedule = JSON.parse(JSON.stringify(originalSchedule));

    // Initialize groups and standby75Days
    Object.values(schedule.scheduleByNurse).forEach((nurseData: any) => {
      if (!nurseData.groups) {
        nurseData.groups = new Array(nurseData.shifts?.length || 0).fill('');
      }
      if (!nurseData.standby75Days) {
        nurseData.standby75Days = [];
      }
    });

    if (!schedule.weekConfirmed) {
      schedule.weekConfirmed = {
        week1: false, week2: false, week3: false,
        week4: false, week5: false, week6: false,
      };
    }

    const yearMonth = schedule.yearMonth;
    const [year, month] = yearMonth.split('-').map(Number);
    const daysInMonth = schedule.maxDaysInMonth || new Date(year, month, 0).getDate();
    const prevMonthDays = new Date(year, month - 1, 0).getDate();

    // Calculate week boundaries
    const firstDayOfMonth = new Date(year, month - 1, 1);
    const lastDayOfMonth = new Date(year, month, 0);
    const firstDayWeekday = firstDayOfMonth.getDay();
    const lastDayWeekday = lastDayOfMonth.getDay();

    let firstWeekMondayOffset: number;
    if (firstDayWeekday === 0) {
      firstWeekMondayOffset = 1;
    } else if (firstDayWeekday === 1) {
      firstWeekMondayOffset = 0;
    } else {
      firstWeekMondayOffset = -(firstDayWeekday - 1);
    }

    let lastWeekSaturdayOffset: number;
    if (lastDayWeekday === 6) {
      lastWeekSaturdayOffset = 0;
    } else if (lastDayWeekday === 0) {
      lastWeekSaturdayOffset = -1;
    } else {
      lastWeekSaturdayOffset = 6 - lastDayWeekday;
    }

    const allWeekDays: any[] = [];
    let currentDay = 1 + firstWeekMondayOffset;
    const lastDay = daysInMonth + lastWeekSaturdayOffset;

    while (currentDay <= lastDay) {
      const actualDate = new Date(year, month - 1, currentDay);
      const dayOfWeek = actualDate.getDay();
      if (dayOfWeek !== 0) {
        let dayInfo: any;
        if (currentDay < 1) {
          dayInfo = { dayIndex: prevMonthDays + currentDay - 1, isCurrentMonth: false, isPrevMonth: true, isNextMonth: false, displayDay: currentDay };
        } else if (currentDay > daysInMonth) {
          dayInfo = { dayIndex: currentDay - daysInMonth - 1, isCurrentMonth: false, isPrevMonth: false, isNextMonth: true, displayDay: currentDay };
        } else {
          dayInfo = { dayIndex: currentDay - 1, isCurrentMonth: true, isPrevMonth: false, isNextMonth: false, displayDay: currentDay };
        }
        allWeekDays.push(dayInfo);
      }
      currentDay++;
    }

    // Group into weeks of 6 days each
    const weeks: any[][] = [];
    for (let i = 0; i < allWeekDays.length; i += 6) {
      weeks.push(allWeekDays.slice(i, i + 6));
    }

    let groupCounts: any = null;
    let standby75Counts: any = null;

    weeks.forEach((weekDays) => {
      const weeklyContext: any = {
        nurses816: new Set(), nurseHospitalDays: {},
        nurse75Days: {}, nurseStandby75Days: {},
      };

      // Build weeklyContext
      weekDays.forEach((dayInfo: any) => {
        let scheduleToScan: any = null;
        if (dayInfo.isCurrentMonth) {
          scheduleToScan = schedule;
        } else if (dayInfo.isPrevMonth) {
          scheduleToScan = this.prevMonthSchedule;
        } else if (dayInfo.isNextMonth) {
          scheduleToScan = this.nextMonthSchedule;
        }
        if (!scheduleToScan?.scheduleByNurse) return;

        Object.entries(scheduleToScan.scheduleByNurse).forEach(([nurseId, nurseData]: [string, any]) => {
          const shift = nurseData.shifts?.[dayInfo.dayIndex];
          if (!shift) return;
          const s = shift.trim();
          if (s === '816') weeklyContext.nurses816.add(nurseId);
          if (s === '75') {
            if (!weeklyContext.nurse75Days[nurseId]) weeklyContext.nurse75Days[nurseId] = [];
            weeklyContext.nurse75Days[nurseId].push(dayInfo.displayDay);
          }
          if (nurseData.standby75Days?.includes(dayInfo.dayIndex)) {
            if (!weeklyContext.nurseStandby75Days[nurseId]) weeklyContext.nurseStandby75Days[nurseId] = [];
            weeklyContext.nurseStandby75Days[nurseId].push(dayInfo.displayDay);
          }
        });
      });

      const currentMonthDays = weekDays.filter((d: any) => d.isCurrentMonth).map((d: any) => d.dayIndex);
      if (currentMonthDays.length > 0) {
        const adjustedContext = {
          ...weeklyContext,
          nurse75Days: {} as Record<string, number[]>,
          nurseStandby75Days: {} as Record<string, number[]>,
        };
        Object.entries(weeklyContext.nurse75Days).forEach(([nurseId, days]: [string, any]) => {
          adjustedContext.nurse75Days[nurseId] = days.map((d: number) => d - 1);
        });
        Object.entries(weeklyContext.nurseStandby75Days).forEach(([nurseId, days]: [string, any]) => {
          adjustedContext.nurseStandby75Days[nurseId] = days.map((d: number) => d - 1);
        });

        const result = this.assignGroupsForDays(schedule, currentMonthDays, groupCounts, standby75Counts, adjustedContext);
        groupCounts = result.groupCounts;
        standby75Counts = result.standby75Counts;
      }
    });

    return schedule;
  }

  /**
   * Redistribute remaining (unconfirmed) weeks
   */
  redistributeRemainingWeeks(schedule: any, weeklyData: any[]): any {
    if (!schedule || !weeklyData) return schedule;

    const config = this.groupConfig || getDefaultConfig();
    const dayRules = config.dayShiftRules || {};
    const all75Groups = new Set<string>();
    (dayRules['135']?.shift75Groups || ['F']).forEach((g: string) => all75Groups.add(g));
    (dayRules['246']?.shift75Groups || ['F', 'J']).forEach((g: string) => all75Groups.add(g));
    const baseAvailable75Groups = Array.from(all75Groups);

    // Initialize counters
    const groupCounts: any = {};
    const standby75Counts: any = {};
    Object.keys(schedule.scheduleByNurse).forEach((nurseId: string) => {
      const init75: Record<string, number> = {};
      baseAvailable75Groups.forEach(g => init75[g] = 0);
      groupCounts[nurseId] = { '74': {}, '75': init75, '311': {} };
      standby75Counts[nurseId] = 0;
    });

    // Tally confirmed weeks
    weeklyData.forEach((week: any, weekIndex: number) => {
      if (schedule.weekConfirmed?.[`week${weekIndex + 1}`]) {
        week.days.forEach((day: any) => {
          if (day.isCurrentMonth) {
            Object.entries(schedule.scheduleByNurse).forEach(([nurseId, nurseData]: [string, any]) => {
              const group = nurseData.groups?.[day.dayIndex];
              const shift = nurseData.shifts?.[day.dayIndex];
              if (group && shift) {
                if (shift === '74') groupCounts[nurseId]['74'][group] = (groupCounts[nurseId]['74'][group] || 0) + 1;
                else if (shift === '75') groupCounts[nurseId]['75'][group] = (groupCounts[nurseId]['75'][group] || 0) + 1;
                else if (this.isNightShift(shift)) groupCounts[nurseId]['311'][group] = (groupCounts[nurseId]['311'][group] || 0) + 1;
              }
              if (nurseData.standby75Days?.includes(day.dayIndex)) standby75Counts[nurseId]++;
            });
          }
        });
      }
    });

    // Clear and reassign unconfirmed weeks
    weeklyData.forEach((week: any, weekIndex: number) => {
      if (!schedule.weekConfirmed?.[`week${weekIndex + 1}`]) {
        const weekDayIndices: number[] = [];
        week.days.forEach((day: any) => {
          if (day.isCurrentMonth) {
            weekDayIndices.push(day.dayIndex);
            Object.entries(schedule.scheduleByNurse).forEach(([, nurseData]: [string, any]) => {
              if (nurseData.groups) nurseData.groups[day.dayIndex] = '';
              if (nurseData.standby75Days) {
                const idx = nurseData.standby75Days.indexOf(day.dayIndex);
                if (idx > -1) nurseData.standby75Days.splice(idx, 1);
              }
            });
          }
        });

        if (weekDayIndices.length > 0) {
          const weeklyContext: any = {
            nurses816: new Set(), nurseHospitalDays: {},
            nurse75Days: {}, nurseStandby75Days: {},
          };

          week.days.forEach((day: any) => {
            let scheduleToScan: any = null;
            if (day.isCurrentMonth) scheduleToScan = schedule;
            else if (day.isPrevMonth) scheduleToScan = this.prevMonthSchedule;
            else if (day.isNextMonth) scheduleToScan = this.nextMonthSchedule;
            if (!scheduleToScan?.scheduleByNurse) return;

            Object.entries(scheduleToScan.scheduleByNurse).forEach(([nurseId, nurseData]: [string, any]) => {
              const shift = nurseData.shifts?.[day.dayIndex];
              if (!shift) return;
              const s = shift.trim();
              if (s === '816') weeklyContext.nurses816.add(nurseId);
              if (s === '75') {
                if (!weeklyContext.nurse75Days[nurseId]) weeklyContext.nurse75Days[nurseId] = [];
                weeklyContext.nurse75Days[nurseId].push(day.dayIndex);
              }
              if (nurseData.standby75Days?.includes(day.dayIndex)) {
                if (!weeklyContext.nurseStandby75Days[nurseId]) weeklyContext.nurseStandby75Days[nurseId] = [];
                weeklyContext.nurseStandby75Days[nurseId].push(day.dayIndex);
              }
            });
          });

          const result = this.assignGroupsForDays(schedule, weekDayIndices, groupCounts, standby75Counts, weeklyContext);
          Object.assign(groupCounts, result.groupCounts);
          Object.assign(standby75Counts, result.standby75Counts);
        }
      }
    });

    return schedule;
  }

  /**
   * Core day-by-day group assignment logic
   */
  private assignGroupsForDays(
    schedule: any, dayIndices: number[],
    groupCounts: any, standby75Counts: any, weeklyContext: any
  ): { groupCounts: any; standby75Counts: any; weeklyContext: any } {
    const config = this.groupConfig || getDefaultConfig();
    const yearMonth = schedule.yearMonth;
    const [year, month] = yearMonth.split('-').map(Number);

    const cannotBeNightLeaderIds: string[] = config.cannotBeNightLeader || [];
    const configGroupCounts = config.groupCounts || {};
    const dayRules = config.dayShiftRules || {};
    const fixedAssignments = config.fixedAssignments || {};
    const hospitalGroups = config.hospitalGroups || { dayShift: ['H', 'I'], nightShift: ['G', 'H'] };
    const nightShiftRestrictions = config.nightShiftRestrictions || {};
    const excludedNurses = new Set(config.excludedNurses || []);

    const getDayShiftGroupsForDay = (dayOfWeek: number) => {
      const weekdayKey = [1, 3, 5].includes(dayOfWeek) ? '135' : '246';
      const dayShiftCount = configGroupCounts[weekdayKey]?.dayShiftCount || 8;
      const dayShiftAvailable = generateDayShiftGroups(dayShiftCount);
      const shift75Groups = dayRules[weekdayKey]?.shift75Groups || ['F'];
      const shift74Groups = calculate74Groups(dayShiftAvailable, shift75Groups);
      return { groups74: shift74Groups, groups75: shift75Groups };
    };

    const getNightGroups = (dayOfWeek: number) => {
      const weekdayKey = [1, 3, 5].includes(dayOfWeek) ? '135' : '246';
      const nightShiftCount = configGroupCounts[weekdayKey]?.nightShiftCount || 9;
      return generateNightShiftGroups(nightShiftCount);
    };

    const isHospitalGroup = (group: string, shiftType: string) => {
      if (shiftType === 'day') return (hospitalGroups.dayShift || ['H', 'I']).includes(group);
      if (shiftType === 'night') return (hospitalGroups.nightShift || ['G', 'H']).includes(group);
      return false;
    };

    // Collect all 75-shift groups
    const all75Groups = new Set<string>();
    (dayRules['135']?.shift75Groups || ['F']).forEach((g: string) => all75Groups.add(g));
    (dayRules['246']?.shift75Groups || ['F', 'J']).forEach((g: string) => all75Groups.add(g));
    const baseAvailable75Groups = Array.from(all75Groups);

    // Initialize counters
    if (!groupCounts) {
      groupCounts = {};
      Object.keys(schedule.scheduleByNurse).forEach((nurseId: string) => {
        const init75: Record<string, number> = {};
        baseAvailable75Groups.forEach(g => init75[g] = 0);
        groupCounts[nurseId] = { '74': {}, '75': init75, '311': {} };
      });
    }
    if (!standby75Counts) {
      standby75Counts = {};
      Object.keys(schedule.scheduleByNurse).forEach((nurseId: string) => {
        standby75Counts[nurseId] = schedule.scheduleByNurse[nurseId].standby75Days?.length || 0;
      });
    }
    if (!weeklyContext) {
      weeklyContext = {
        nurses816: new Set(), nurseHospitalDays: {},
        nurse75Days: {}, nurseStandby75Days: {},
      };
    }

    let next75GroupIndex = 0;
    if (baseAvailable75Groups.length > 0) {
      for (let i = dayIndices[0] - 1; i >= 0; i--) {
        let found75 = false;
        Object.values(schedule.scheduleByNurse).forEach((nurseData: any) => {
          if (nurseData.shifts?.[i] === '75' && nurseData.groups?.[i]) {
            const usedIndex = baseAvailable75Groups.indexOf(nurseData.groups[i]);
            if (usedIndex >= 0) {
              next75GroupIndex = (usedIndex + 1) % baseAvailable75Groups.length;
              found75 = true;
            }
          }
        });
        if (found75) break;
      }
    }

    // Process each day
    dayIndices.forEach((dayIndex: number) => {
      const date = new Date(year, month - 1, dayIndex + 1);
      const dayOfWeek = date.getDay();
      const dayShiftGroups = getDayShiftGroupsForDay(dayOfWeek);
      const available74Groups = dayShiftGroups.groups74;
      const available75Groups = dayShiftGroups.groups75;
      const nightGroups = getNightGroups(dayOfWeek);

      const nurses74: string[] = [];
      const nurses75: string[] = [];
      const nurses74L: string[] = [];
      const nurses816: string[] = [];
      const nurses311: string[] = [];
      const nurses311C: string[] = [];
      const eligibleFor75Standby: string[] = [];

      Object.entries(schedule.scheduleByNurse).forEach(([nurseId, nurseData]: [string, any]) => {
        const shift = nurseData.shifts?.[dayIndex];
        if (!shift) return;
        if (excludedNurses.has(nurseId)) return;
        const s = shift.trim();
        if (s.includes('\u4f11') || s.includes('\u4f8b') || s.includes('\u570b\u5b9a')) return;
        if (s === '74') { nurses74.push(nurseId); eligibleFor75Standby.push(nurseId); }
        else if (s === '75') nurses75.push(nurseId);
        else if (s === '74/L') nurses74L.push(nurseId);
        else if (s === '816') nurses816.push(nurseId);
        else if (s === '311C') nurses311C.push(nurseId);
        else if (this.isNightShift(s)) nurses311.push(nurseId);
      });

      // 74/L -> A group
      nurses74L.forEach(id => {
        schedule.scheduleByNurse[id].groups[dayIndex] = fixedAssignments['74/L'] || 'A';
      });

      // 816 -> perimeter group
      nurses816.forEach(id => {
        schedule.scheduleByNurse[id].groups[dayIndex] = fixedAssignments['816'] || '\u5916\u570d';
      });

      // 75-shift grouping
      if (nurses75.length > 0 && available75Groups.length > 0) {
        if (nurses75.length === 1) {
          const group = available75Groups[next75GroupIndex % available75Groups.length];
          schedule.scheduleByNurse[nurses75[0]].groups[dayIndex] = group;
          groupCounts[nurses75[0]]['75'][group] = (groupCounts[nurses75[0]]['75'][group] || 0) + 1;
          next75GroupIndex = (next75GroupIndex + 1) % baseAvailable75Groups.length;
        } else {
          const assignedNurses75 = new Set<string>();
          available75Groups.forEach((group: string) => {
            let bestNurse: string | null = null;
            let minCount = Infinity;
            nurses75.forEach(id => {
              if (!assignedNurses75.has(id)) {
                const count = groupCounts[id]?.['75']?.[group] || 0;
                if (count < minCount) { minCount = count; bestNurse = id; }
              }
            });
            if (bestNurse) {
              schedule.scheduleByNurse[bestNurse].groups[dayIndex] = group;
              groupCounts[bestNurse]['75'][group] = (groupCounts[bestNurse]['75'][group] || 0) + 1;
              assignedNurses75.add(bestNurse);
            }
          });
          nurses75.forEach(id => {
            if (!assignedNurses75.has(id)) {
              let minCount = Infinity, minGroup = available75Groups[0];
              available75Groups.forEach((g: string) => {
                const c = groupCounts[id]?.['75']?.[g] || 0;
                if (c < minCount) { minCount = c; minGroup = g; }
              });
              schedule.scheduleByNurse[id].groups[dayIndex] = minGroup;
              groupCounts[id]['75'][minGroup] = (groupCounts[id]['75'][minGroup] || 0) + 1;
            }
          });
          next75GroupIndex = (next75GroupIndex + 1) % baseAvailable75Groups.length;
        }
      }

      // 74-shift grouping (with hospital group constraints)
      if (nurses74.length > 0 && available74Groups.length > 0) {
        const hospitalGroupsToday = available74Groups.filter((g: string) => isHospitalGroup(g, 'day'));
        const usedGroups74 = new Set<string>();
        const assignedNurses74 = new Set<string>();

        // Assign hospital groups first
        if (hospitalGroupsToday.length > 0) {
          const hospitalCandidates = nurses74
            .filter(id => {
              if (weeklyContext.nurses816.has(id)) return false;
              const hDays = weeklyContext.nurseHospitalDays[id] || [];
              return hDays.length < 2;
            })
            .map(id => {
              const hDays = weeklyContext.nurseHospitalDays[id] || [];
              const hadYesterday = hDays.includes(dayIndex - 1);
              const hCount = (groupCounts[id]?.['74']?.['H'] || 0) + (groupCounts[id]?.['74']?.['I'] || 0);
              return { nurseId: id, score: hCount * 100 + hDays.length * 10 + (hadYesterday ? 5 : 0) };
            })
            .sort((a, b) => a.score - b.score);

          hospitalGroupsToday.forEach((group: string) => {
            const candidate = hospitalCandidates.find(c => !assignedNurses74.has(c.nurseId));
            if (candidate) {
              schedule.scheduleByNurse[candidate.nurseId].groups[dayIndex] = group;
              groupCounts[candidate.nurseId]['74'][group] = (groupCounts[candidate.nurseId]['74'][group] || 0) + 1;
              usedGroups74.add(group);
              assignedNurses74.add(candidate.nurseId);
              if (!weeklyContext.nurseHospitalDays[candidate.nurseId]) weeklyContext.nurseHospitalDays[candidate.nurseId] = [];
              weeklyContext.nurseHospitalDays[candidate.nurseId].push(dayIndex);
            }
          });
        }

        // Assign remaining groups
        const rem74Nurses = nurses74.filter(id => !assignedNurses74.has(id));
        const rem74Groups = available74Groups.filter((g: string) => !usedGroups74.has(g));
        if (rem74Nurses.length > 0 && rem74Groups.length > 0) {
          const pairs: { nurseId: string; group: string; count: number }[] = [];
          rem74Nurses.forEach(id => {
            rem74Groups.forEach((g: string) => {
              pairs.push({ nurseId: id, group: g, count: groupCounts[id]?.['74']?.[g] || 0 });
            });
          });
          pairs.sort((a, b) => a.count - b.count);
          pairs.forEach(({ nurseId, group }) => {
            if (!assignedNurses74.has(nurseId) && !usedGroups74.has(group)) {
              schedule.scheduleByNurse[nurseId].groups[dayIndex] = group;
              groupCounts[nurseId]['74'][group] = (groupCounts[nurseId]['74'][group] || 0) + 1;
              usedGroups74.add(group);
              assignedNurses74.add(nurseId);
            }
          });
        }
      }

      // 311C -> C group
      nurses311C.forEach(id => {
        schedule.scheduleByNurse[id].groups[dayIndex] = fixedAssignments['311C'] || 'C';
        groupCounts[id]['311']['C'] = (groupCounts[id]['311']['C'] || 0) + 1;
      });

      // Night shift grouping
      if (nurses311.length > 0 && nightGroups.length > 0) {
        const canBeLeader: string[] = [];
        const cannotBeLeader: string[] = [];
        nurses311.forEach(id => {
          if (cannotBeNightLeaderIds.includes(id)) cannotBeLeader.push(id);
          else canBeLeader.push(id);
        });

        const getAvailNight = (nurseId: string, groups: string[], excludeHosp = false) => {
          let avail = [...groups];
          if (weeklyContext.nurses816.has(nurseId)) avail = avail.filter((g: string) => !isHospitalGroup(g, 'night'));
          const hDays = weeklyContext.nurseHospitalDays[nurseId] || [];
          if (hDays.length >= 2) avail = avail.filter((g: string) => !isHospitalGroup(g, 'night'));
          if (excludeHosp || hDays.includes(dayIndex - 1)) avail = avail.filter((g: string) => !isHospitalGroup(g, 'night'));
          const restrictions = nightShiftRestrictions[nurseId] || [];
          if (restrictions.length > 0) avail = avail.filter((g: string) => !restrictions.includes(g));
          return avail;
        };

        const sortByTotal = (arr: string[]) => {
          arr.sort((a, b) => {
            const ac = Object.values(groupCounts[a]?.['311'] || {}).reduce((s: number, c: any) => s + (c as number), 0) as number;
            const bc = Object.values(groupCounts[b]?.['311'] || {}).reduce((s: number, c: any) => s + (c as number), 0) as number;
            return ac - bc;
          });
        };
        sortByTotal(canBeLeader);
        sortByTotal(cannotBeLeader);

        let groupIdx = 0;

        // A group -> Leader
        if (nightGroups[0] === 'A' && canBeLeader.length > 0) {
          let selLeader: string | null = null;
          let minA = Infinity;
          canBeLeader.forEach(id => {
            const avail = getAvailNight(id, nightGroups);
            if (avail.includes('A')) {
              const ac = groupCounts[id]?.['311']?.['A'] || 0;
              if (ac < minA) { selLeader = id; minA = ac; }
            }
          });
          if (selLeader) {
            schedule.scheduleByNurse[selLeader].groups[dayIndex] = 'A';
            groupCounts[selLeader]['311']['A'] = (groupCounts[selLeader]['311']['A'] || 0) + 1;
            canBeLeader.splice(canBeLeader.indexOf(selLeader), 1);
            groupIdx = 1;
          }
        }

        const remNightNurses = [...canBeLeader, ...cannotBeLeader];
        let remNightGroups = nightGroups.slice(groupIdx);
        if (nurses311C.length > 0) remNightGroups = remNightGroups.filter((g: string) => g !== 'C');

        if (remNightNurses.length > 0 && remNightGroups.length > 0) {
          const hospNightGroups = remNightGroups.filter((g: string) => isHospitalGroup(g, 'night'));
          const assignedN = new Set<string>();
          const assignedG = new Set<string>();

          // Hospital groups first
          if (hospNightGroups.length > 0) {
            const cands = remNightNurses
              .filter(id => getAvailNight(id, hospNightGroups).length > 0)
              .map(id => {
                const hDays = weeklyContext.nurseHospitalDays[id] || [];
                const hadY = hDays.includes(dayIndex - 1);
                const mc = (groupCounts[id]?.['311']?.['G'] || 0) + (groupCounts[id]?.['311']?.['H'] || 0);
                return { nurseId: id, score: mc * 100 + hDays.length * 10 + (hadY ? 5 : 0), avail: getAvailNight(id, hospNightGroups) };
              })
              .sort((a, b) => a.score - b.score);

            hospNightGroups.forEach((group: string) => {
              const c = cands.find(x => !assignedN.has(x.nurseId) && x.avail.includes(group));
              if (c) {
                schedule.scheduleByNurse[c.nurseId].groups[dayIndex] = group;
                groupCounts[c.nurseId]['311'][group] = (groupCounts[c.nurseId]['311'][group] || 0) + 1;
                assignedN.add(c.nurseId);
                assignedG.add(group);
                if (!weeklyContext.nurseHospitalDays[c.nurseId]) weeklyContext.nurseHospitalDays[c.nurseId] = [];
                weeklyContext.nurseHospitalDays[c.nurseId].push(dayIndex);
              }
            });
          }

          // Non-hospital groups
          const stillN = remNightNurses.filter(id => !assignedN.has(id));
          const stillG = remNightGroups.filter((g: string) => !assignedG.has(g));
          if (stillN.length > 0 && stillG.length > 0) {
            const pairs: { nurseId: string; group: string; count: number }[] = [];
            stillN.forEach(id => {
              const avail = getAvailNight(id, stillG, true);
              avail.forEach((g: string) => {
                pairs.push({ nurseId: id, group: g, count: groupCounts[id]?.['311']?.[g] || 0 });
              });
            });
            pairs.sort((a, b) => a.count - b.count);
            pairs.forEach(({ nurseId, group }) => {
              if (!assignedN.has(nurseId) && !assignedG.has(group)) {
                schedule.scheduleByNurse[nurseId].groups[dayIndex] = group;
                groupCounts[nurseId]['311'][group] = (groupCounts[nurseId]['311'][group] || 0) + 1;
                assignedN.add(nurseId);
                assignedG.add(group);
              }
            });
          }
        }
      }

      // Standby 75 assignment
      if (eligibleFor75Standby.length > 0) {
        const valid = eligibleFor75Standby.filter(id => {
          const todayGrp = schedule.scheduleByNurse[id].groups[dayIndex];
          if (isHospitalGroup(todayGrp, 'day')) return false;
          const n75 = weeklyContext.nurse75Days[id] || [];
          if (n75.some((d: number) => Math.abs(dayIndex - d) <= 1)) return false;
          const nS75 = weeklyContext.nurseStandby75Days[id] || [];
          if (nS75.some((d: number) => Math.abs(dayIndex - d) <= 1)) return false;
          if (n75.length + nS75.length >= 2) return false;
          return true;
        });

        if (valid.length > 0) {
          valid.sort((a, b) => (standby75Counts[a] || 0) - (standby75Counts[b] || 0));
          const minC = standby75Counts[valid[0]] || 0;
          const cands = valid.filter(id => (standby75Counts[id] || 0) === minC);
          const selId = cands[Math.floor(Math.random() * cands.length)];

          if (!schedule.scheduleByNurse[selId].standby75Days) schedule.scheduleByNurse[selId].standby75Days = [];
          schedule.scheduleByNurse[selId].standby75Days.push(dayIndex);
          standby75Counts[selId] = (standby75Counts[selId] || 0) + 1;

          if (!weeklyContext.nurseStandby75Days[selId]) weeklyContext.nurseStandby75Days[selId] = [];
          weeklyContext.nurseStandby75Days[selId].push(dayIndex);
        }
      }
    });

    return { groupCounts, standby75Counts, weeklyContext };
  }

  // Shift type helpers
  private isNightShift(shift: string): boolean {
    const s = (shift || '').trim();
    return ['311', '3-11', '311C'].some(ns => s.includes(ns));
  }

  /**
   * Build config-based dashboard header and nurse counts
   */
  buildGroupCountsDashboard(schedule: any): { header: string[]; nurses: any[] } {
    if (!schedule || !schedule.scheduleByNurse) {
      return { header: ['\u8b77\u7406\u5e2b'], nurses: [] };
    }

    const config = this.groupConfig || getDefaultConfig();
    const configGroupCounts = config.groupCounts || {};

    const dayCount135 = configGroupCounts['135']?.dayShiftCount || 8;
    const dayCount246 = configGroupCounts['246']?.dayShiftCount || 9;
    const nightCount135 = configGroupCounts['135']?.nightShiftCount || 9;
    const nightCount246 = configGroupCounts['246']?.nightShiftCount || 8;

    const maxDayCount = Math.max(dayCount135, dayCount246);
    const maxNightCount = Math.max(nightCount135, nightCount246);

    const fixedDayGroups = generateDayShiftGroups(maxDayCount);
    const fixedNightGroups = generateNightShiftGroups(maxNightCount);
    const allDayGroups = ['A', ...fixedDayGroups, '\u5916\u570d'];

    const nursesMap: Record<string, any> = {};

    Object.entries(schedule.scheduleByNurse).forEach(([nurseId, nurseData]: [string, any]) => {
      if (!nursesMap[nurseId]) {
        nursesMap[nurseId] = {
          id: nurseId,
          name: nurseData.nurseName,
          dayCounts: {} as Record<string, number>,
          nightCounts: {} as Record<string, number>,
          standby75Count: 0,
        };
      }

      if (nurseData.groups && nurseData.shifts) {
        nurseData.groups.forEach((group: string, index: number) => {
          if (group) {
            const shift = nurseData.shifts[index];
            if (shift && this.isDayShift(shift)) {
              nursesMap[nurseId].dayCounts[group] = (nursesMap[nurseId].dayCounts[group] || 0) + 1;
            } else if (shift && this.isNightShift(shift)) {
              nursesMap[nurseId].nightCounts[group] = (nursesMap[nurseId].nightCounts[group] || 0) + 1;
            }
          }
        });
      }

      if (nurseData.standby75Days && nurseData.standby75Days.length > 0) {
        nursesMap[nurseId].standby75Count = nurseData.standby75Days.length;
      }
    });

    // Build header
    const header = ['\u8b77\u7406\u5e2b'];
    allDayGroups.forEach(group => header.push(`\u767d${group}`));
    fixedNightGroups.forEach(group => header.push(`\u665a${group}`));
    header.push('\u9810\u508775');

    // Build nurse list
    const nursesList = Object.entries(nursesMap).map(([id, nd]: [string, any]) => {
      const counts: Record<string, number> = {};
      allDayGroups.forEach(group => { counts[`\u767d${group}`] = nd.dayCounts[group] || 0; });
      fixedNightGroups.forEach(group => { counts[`\u665a${group}`] = nd.nightCounts[group] || 0; });
      counts['\u9810\u508775'] = nd.standby75Count || 0;
      return { id, name: nd.name, counts };
    });

    // Sort by processingOrder
    if (schedule.processingOrder && schedule.processingOrder.length > 0) {
      const orderMap = new Map(schedule.processingOrder.map((id: string, index: number) => [id, index]));
      nursesList.sort((a, b) => {
        const oa = (orderMap.get(a.id) as number) ?? 999;
        const ob = (orderMap.get(b.id) as number) ?? 999;
        return oa - ob;
      });
    } else {
      nursesList.sort((a, b) => {
        const na = parseInt(a.id) || 999;
        const nb = parseInt(b.id) || 999;
        return na !== nb ? na - nb : a.id.localeCompare(b.id);
      });
    }

    return { header, nurses: nursesList };
  }

  private isDayShift(shift: string): boolean {
    const s = (shift || '').trim();
    return ['74', '74/L', '75', '816'].includes(s);
  }
}
