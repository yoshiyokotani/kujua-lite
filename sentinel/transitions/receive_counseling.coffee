Transition = require('./transition')
_ = require('underscore')

module.exports = new Transition(
  filter: (doc) ->
    { form, tasks } = doc
    form is 'OANC' and tasks.length is 0
  onMatch: (change) ->
    { doc } = change
    @addAcknowledgement(doc)
    @unscheduleReminders(doc)
    @db.saveDoc(doc, @callback)
  addAcknowledgement: (doc) ->
    { from, related_entities, tasks } = doc
    name = related_entities?.clinic?.name or 'health volunteer'
    tasks.push(
      messages: [ to: from, message: "Thank you, #{name}. ANC counseling visit has been recorded." ]
      state: 'pending'
    )
  unscheduleReminders: (doc) ->
    @db.view('kujua-sentinel', 'obsolete_scheduled_tasks', key: doc.patient_id, (err, data) =>
      { rows } = data
      _.each(rows, (row) ->
        { value } = row
        { doc, indexes } = value
        { scheduled_tasks } = doc
        _.each(indexes, (index) ->
          scheduled_tasks.splice(index, 1)
        )
        @db.saveDoc(doc)
      , @)
    )
)

