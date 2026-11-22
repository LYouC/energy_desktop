<script setup lang="ts">
import { Trash2 } from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
defineProps<{ count: number; total: number; allSelected: boolean }>();
defineEmits<{ toggleAll: []; remove: [] }>();
</script>
<template>
  <div class="manage-bar" role="toolbar" aria-label="批量管理任务">
    <span class="manage-count"
      >已选 <strong>{{ count }}</strong> 项</span
    >
    <button type="button" class="manage-link" @click="$emit('toggleAll')">
      {{ allSelected ? "取消全选" : "全选" }}
    </button>
    <span class="manage-total">共 {{ total }} 项</span>
    <span class="manage-spacer"></span>
    <slot name="actions">
      <Button variant="destructive" :disabled="!count" @click="$emit('remove')"
        ><Trash2 :size="15" />删除选中</Button
      >
    </slot>
  </div>
</template>
