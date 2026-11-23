<script setup lang="ts">
import { Copy, Minus, Square, X } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref } from "vue";

const maximized = ref(false);
const { controlWindow } = window.desktop;
const maximizeLabel = computed(() =>
  maximized.value ? "还原窗口" : "最大化窗口",
);
let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  unsubscribe = window.desktop.onWindowMaximized((value) => {
    maximized.value = value;
  });
  maximized.value = await window.desktop.isWindowMaximized();
});
onUnmounted(() => unsubscribe?.());
</script>

<template>
  <header class="window-titlebar">
    <div class="window-controls" role="group" aria-label="窗口控件">
      <button
        type="button"
        aria-label="最小化窗口"
        title="最小化窗口"
        @click="controlWindow('minimize')"
      >
        <Minus :size="15" />
      </button>
      <button
        type="button"
        :aria-label="maximizeLabel"
        :title="maximizeLabel"
        @click="controlWindow('toggleMaximize')"
      >
        <Copy v-if="maximized" :size="12" />
        <Square v-else :size="12" />
      </button>
      <button
        type="button"
        class="window-close"
        aria-label="关闭窗口"
        title="关闭窗口"
        @click="controlWindow('close')"
      >
        <X :size="16" />
      </button>
    </div>
  </header>
</template>
