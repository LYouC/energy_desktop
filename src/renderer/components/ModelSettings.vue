<script setup lang="ts">
import { ref, watch } from "vue";
import Modal from "./Modal.vue";
import Button from "./ui/button/Button.vue";

const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ configured: [] }>();
const baseURL = ref("");
const model = ref("");
const apiKey = ref("");
const hasKey = ref(false);
const busy = ref(false);
const error = ref("");
watch(open, async (value) => {
  apiKey.value = "";
  error.value = "";
  if (!value) return;
  busy.value = true;
  try {
    const config = await window.desktop.agentConfig();
    baseURL.value = config.baseURL;
    model.value = config.model;
    hasKey.value = config.hasKey;
  } catch {
    error.value = "无法读取模型配置，请关闭后重试。";
  } finally {
    busy.value = false;
  }
});
async function save() {
  busy.value = true;
  error.value = "";
  try {
    // 密钥只交给本地执行层。表单清空后，页面只保留是否已配置这一状态。
    await window.desktop.configureAgent({
      baseURL: baseURL.value.trim(),
      model: model.value.trim(),
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    });
    apiKey.value = "";
    emit("configured");
    open.value = false;
  } catch {
    apiKey.value = "";
    error.value =
      "保存失败，请检查 HTTPS 服务地址、模型名称及本机凭据保护是否可用。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal
    v-model:open="open"
    title="模型设置"
    description="发送消息时，相关任务和对话会传给所配置的模型服务。"
  >
    <form class="task-form" @submit.prevent="save">
      <label class="full"
        >服务地址<input
          v-model="baseURL"
          aria-label="模型服务地址"
          type="url"
          required
          :disabled="busy"
      /></label>
      <label class="full"
        >模型名称<input
          v-model="model"
          aria-label="模型名称"
          required
          :disabled="busy"
      /></label>
      <label class="full"
        >API Key<input
          v-model="apiKey"
          aria-label="模型 API Key"
          type="password"
          autocomplete="off"
          :placeholder="hasKey ? '已配置，留空沿用现有 Key' : '输入 API Key'"
          :disabled="busy"
      /></label>
      <p v-if="error" class="error full" role="alert">{{ error }}</p>
      <div class="full row">
        <Button
          type="submit"
          :disabled="
            busy ||
            !baseURL.trim() ||
            !model.trim() ||
            (!hasKey && !apiKey.trim())
          "
          >{{ busy ? "正在保存…" : "保存模型设置" }}</Button
        >
      </div>
    </form>
  </Modal>
</template>
