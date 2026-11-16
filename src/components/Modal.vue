<script setup lang="ts">
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import { X } from 'lucide-vue-next'
defineProps<{ title: string; description?: string }>()
const open = defineModel<boolean>('open', { required: true })
</script>
<template>
  <DialogRoot v-model:open="open"><DialogPortal><DialogOverlay class="modal-overlay" />
    <DialogContent class="modal-content" :aria-describedby="description ? undefined : undefined">
      <div class="modal-heading"><DialogTitle>{{ title }}</DialogTitle><DialogClose class="icon-button" aria-label="关闭"><X :size="18" /></DialogClose></div>
      <DialogDescription class="muted">{{ description || '修改后保存，即可更新本地数据。' }}</DialogDescription>
      <slot />
    </DialogContent>
  </DialogPortal></DialogRoot>
</template>
