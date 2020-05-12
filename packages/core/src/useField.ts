import { watch, ref, Ref, isRef, reactive, computed, onMounted, toRefs, watchEffect } from 'vue';
import { validate } from './validate';
import {
  FormController,
  ValidationResult,
  MaybeReactive,
  FieldComposite,
  GenericValidateFunction,
  Flag,
} from './types';
import { createFlags, normalizeRules, extractLocators } from './utils';
import { normalizeEventValue } from './utils/events';
import { unwrap } from './utils/refs';

interface FieldOptions {
  value: Ref<any>;
  immediate?: boolean;
  form?: FormController;
}

type RuleExpression = MaybeReactive<string | Record<string, any> | GenericValidateFunction>;

/**
 * Creates a field composite.
 */
export function useField(
  fieldName: MaybeReactive<string>,
  rules: RuleExpression,
  opts?: Partial<FieldOptions>
): FieldComposite {
  const { value, form, immediate } = normalizeOptions(opts);
  const { meta, errors, failedRules, onBlur, handleChange, reset, patch } = useValidationState(value);
  let schemaValidation: GenericValidateFunction;
  const normalizedRules = computed(() => {
    return schemaValidation || normalizeRules(unwrap(rules));
  });

  const runValidation = async (): Promise<ValidationResult> => {
    meta.pending.value = true;
    const result = await validate(value.value, normalizedRules.value, {
      name: unwrap(fieldName),
      values: form?.values.value ?? {},
      names: form?.names.value ?? {},
    });

    patch(result);

    return result;
  };

  watch(value, runValidation, {
    deep: true,
  });

  if (isRef(rules)) {
    watch(rules, runValidation, {
      deep: true,
    });
  }

  onMounted(() => {
    validate(value.value, unwrap(rules)).then(result => {
      if (immediate) {
        patch(result);
        return;
      }

      // Initial silent validation.
      meta.valid.value = result.valid;
      meta.invalid.value = !result.valid;
    });
  });

  const errorMessage = computed(() => {
    return errors.value[0];
  });

  const field = {
    vid: fieldName,
    name: fieldName, // TODO: Custom field names
    value: value,
    meta,
    errors,
    errorMessage,
    failedRules,
    reset,
    validate: runValidation,
    handleChange,
    onBlur,
    __setRules(fn: GenericValidateFunction) {
      schemaValidation = fn;
    },
  };

  useFormController(field, normalizedRules, form);

  return field;
}

/**
 * Normalizes partial field options to include the full
 */
function normalizeOptions(opts: Partial<FieldOptions> | undefined): FieldOptions {
  const defaults = () => ({
    value: ref(null),
    immediate: false,
    rules: '',
  });

  if (!opts) {
    return defaults();
  }

  return {
    ...defaults(),
    ...(opts ?? {}),
  };
}

/**
 * Manages the validation state of a field.
 */
function useValidationState(value: Ref<any>) {
  const errors: Ref<string[]> = ref([]);
  const { onBlur, reset: resetFlags, meta } = useMeta();
  const failedRules: Ref<Record<string, string>> = ref({});
  const initialValue = value.value;

  // Common input/change event handler
  const handleChange = (e: Event) => {
    value.value = normalizeEventValue(e);
    meta.dirty.value = true;
    meta.pristine.value = false;
  };

  // Updates the validation state with the validation result
  function patch(result: ValidationResult) {
    errors.value = result.errors;
    meta.changed.value = initialValue !== value.value;
    meta.valid.value = result.valid;
    meta.invalid.value = !result.valid;
    meta.validated.value = true;
    meta.pending.value = false;
    failedRules.value = result.failedRules;
  }

  // Resets the validation state
  const reset = () => {
    errors.value = [];
    failedRules.value = {};
    resetFlags();
  };

  return {
    meta,
    errors,
    failedRules,
    patch,
    reset,
    onBlur,
    handleChange,
  };
}

/**
 * Associated fields with forms and watches any cross-field validation dependencies.
 */
function useFormController(field: FieldComposite, rules: Ref<Record<string, any>>, form?: FormController) {
  if (!form) return;

  // associate the field with the given form
  form.register(field);

  // extract cross-field dependencies in a computed prop
  const dependencies = computed(() => {
    return Object.keys(rules.value).reduce((acc: string[], rule: string) => {
      const deps = extractLocators(rules.value[rule]).map((dep: any) => dep.__locatorRef);
      acc.push(...deps);

      return acc;
    }, []);
  });

  // Adds a watcher that runs the validation whenever field dependencies change
  watchEffect(() => {
    // Skip if no dependencies
    if (!dependencies.value.length) {
      return;
    }

    // For each dependent field, validate it if it was validated before
    dependencies.value.forEach(dep => {
      if (dep in form.values.value && field.meta.validated.value) {
        field.validate();
      }
    });
  });
}

/**
 * Exposes meta flags state and some associated actions with them.
 */
function useMeta() {
  const flags = reactive(createFlags());
  const passed = computed(() => {
    return flags.valid && flags.validated;
  });

  const failed = computed(() => {
    return flags.invalid && flags.validated;
  });

  /**
   * Handles common onBlur meta update
   */
  const onBlur = () => {
    flags.touched = true;
    flags.untouched = false;
  };

  /**
   * Resets the flag state
   */
  function reset() {
    const defaults = createFlags();
    Object.keys(flags).forEach((key: string) => {
      // Skip these, since they are computed anyways
      if (key === 'passed' || key === 'failed') {
        return;
      }

      flags[key as Flag] = defaults[key as Flag];
    });
  }

  return {
    meta: {
      ...toRefs(flags),
      passed,
      failed,
    },
    onBlur,
    reset,
  };
}