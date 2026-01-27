<template>
  <div class="space-y-4">
    <div class="space-y-2">
      <p class="text-xl font-semibold">
        Preset Activity
      </p>
      <USelectMenu
        v-model="selectedPreset"
        :options="presetOptions"
        placeholder="Choose an activity"
        class="w-full"
      />
      <p class="text-sm text-gray-500">
        Selecting a preset fills the activity name and weekly times. You can still edit below.
      </p>
    </div>
    <p class="text-xl font-semibold">
      Name
    </p>
    <UInput
      v-model="activityName"
      placeholder="Activities + Sports/Drama"
      class="w-full"
    />
    <p class="text-xl font-semibold">
      Schedule
    </p>
    <div class="flex flex-col space-y-4">
      <div
        v-for="day in Object.keys(activityDays)"
        :key="day"
        class="flex flex-row items-center gap-4"
        :class="{ 'text-gray-400': !activityDays[day] }"
      >
        <UCheckbox v-model="activityDays[day]" />
        <p class="font-semibold">
          {{ day }}
        </p>
        <UInput
          v-model="activitySchedule[day].start"
          placeholder="Enter a club name"
          type="time"
          class="w-full"
          :disabled="!activityDays[day]"
        />
        <p>-</p>
        <UInput
          v-model="activitySchedule[day].end"
          placeholder="Enter a club name"
          type="time"
          class="w-full"
          :disabled="!activityDays[day]"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useCustomScheduleStore } from '~/stores/customSchedule';

const customScheduleStore = useCustomScheduleStore();
const { activityName, activityDays, activitySchedule }
  = storeToRefs(customScheduleStore);

const selectedPreset = ref<string | null>(null);

const PRESET_TRACK = 'Track';

const presetOptions = [
  'Softball',
  'Baseball',
  'Boys Volleyball',
  'Boys Golf',
  'Boys Tennis',
  'Girls Lacrosse',
  'Boys Lacrosse',
  PRESET_TRACK,
  'Swimming',
];

const presetScheduleMap: Record<string, { start: string, end: string }> = {
  default: { start: '15:50', end: '17:30' },
  [PRESET_TRACK]: { start: '15:30', end: '17:30' },
};

watch(selectedPreset, (preset) => {
  if (!preset) return;
  activityName.value = preset;
  const schedule = presetScheduleMap[preset] || presetScheduleMap.default;
  for (const day of Object.keys(activityDays.value)) {
    activityDays.value[day] = true;
    activitySchedule.value[day].start = schedule.start;
    activitySchedule.value[day].end = schedule.end;
  }
});
</script>
