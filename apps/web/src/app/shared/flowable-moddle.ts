/**
 * The Flowable extensions this system uses, described for bpmn-moddle.
 *
 * Plan reference: V2 sections 5.2 (authoring contracts), 5.3 (the apiInvoker
 * delegate), 18.1 screen 20.
 *
 * ## Why this file has to exist
 *
 * bpmn-js parses BPMN. Everything in the `flowable` namespace —
 * `candidateGroups` on a user task, the delegate expression on a service
 * task, the `stepCode` and `formId` properties the API validates — is foreign
 * to it. Without a descriptor, the modeller reads a definition, drops what it
 * does not recognise, and writes it back out without those attributes.
 *
 * The result would be a definition that still deploys and produces user tasks
 * belonging to nobody. That is precisely the failure the publish-time
 * validator exists to catch, and it would be introduced by the tool we built
 * to author them. So the descriptor covers every extension the definition
 * uses, and the modeller round-trips them.
 *
 * ## Why it is deliberately partial
 *
 * Flowable's schema is far larger than this. Describing all of it would
 * suggest the modeller supports execution listeners, event registries and
 * decision tasks, none of which the validator will accept. What is here is
 * what a definition in this system may legitimately contain.
 */
export const FLOWABLE_MODDLE = {
  name: 'Flowable',
  uri: 'http://flowable.org/bpmn',
  prefix: 'flowable',
  xml: { tagAlias: 'lowerCase' },

  associations: [],

  types: [
    {
      /** `flowable:candidateGroups` — the roles that may claim a user task. */
      name: 'UserTaskExtensions',
      isAbstract: true,
      extends: ['bpmn:UserTask'],
      properties: [
        { name: 'candidateGroups', isAttr: true, type: 'String' },
        { name: 'candidateUsers', isAttr: true, type: 'String' },
        { name: 'assignee', isAttr: true, type: 'String' },
        { name: 'formKey', isAttr: true, type: 'String' },
        { name: 'dueDate', isAttr: true, type: 'String' },
      ],
    },
    {
      /**
       * `flowable:delegateExpression` — always `${apiInvoker}` here.
       *
       * `class` and `expression` are described too, not because they are
       * allowed, but so that a definition containing one is read faithfully
       * and refused by the validator with the offending value visible. A
       * silently dropped attribute would be refused with nothing to show.
       */
      name: 'ServiceTaskExtensions',
      isAbstract: true,
      extends: ['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'],
      properties: [
        { name: 'delegateExpression', isAttr: true, type: 'String' },
        { name: 'class', isAttr: true, type: 'String' },
        { name: 'expression', isAttr: true, type: 'String' },
        { name: 'resultVariable', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'ProcessExtensions',
      isAbstract: true,
      extends: ['bpmn:Process'],
      properties: [{ name: 'candidateStarterGroups', isAttr: true, type: 'String' }],
    },

    /**
     * A delegate field.
     *
     * The child element matters: `flowable:string` is a literal and
     * `flowable:expression` is evaluated. A field holding `${caseId}` as a
     * string reaches the delegate as those nine characters, which is a
     * mistake this system has already made once.
     */
    {
      name: 'Field',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'string', type: 'String' },
        { name: 'expression', type: 'String' },
        { name: 'stringValue', isAttr: true, type: 'String' },
      ],
    },

    /** `flowable:properties` — where stepCode, formId and roles live. */
    {
      name: 'Properties',
      superClass: ['Element'],
      properties: [{ name: 'values', type: 'Property', isMany: true }],
    },
    {
      name: 'Property',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'value', isAttr: true, type: 'String' },
      ],
    },
  ],

  enumerations: [],
};
