<script setup lang="ts">
import { ListChecks } from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
defineProps<{ active: boolean }>();
defineEmits<{ toggle: [] }>();
</script>
<template>
  <Button variant="ghost" :aria-pressed="active" @click="$emit('toggle')"
    ><ListChecks :size="15" />{{ active ? "完成" : "管理" }}</Button
  >
</template>
