import {
  Subject,
  BehaviorSubject,
  Scheduler,
  Observable
} from '@reactivex/rxjs'

import {
  createState,
  filterActions
} from './util/state'

import {
  parseOpts,
  logAgendas,
  logStore
} from './util/logger'

import assert from './util/assert'
import wrapActions from './util/wrapActions'
import isPromise from './util/isPromise'
import isObservable from './util/isObservable'
import warn from './util/warn'

const _scheduleNotice = warn('Dispatcher method `schedule` is deprecated. Please use `next` instead.')
const _dispatchNotice = warn('Dispatcher method `dispatch` is deprecated. Please use `next` instead.')

const KICKSTART_ACTION = { type: '_INIT_' }

export default function createDispatcher(opts = {}) {
  const dispatcher = new Subject()

  const identifier = Symbol()
  const cache = []

  // Options: Scheduler
  const scheduler = opts.scheduler || Scheduler.queue

  // Options: Logging
  const logging = parseOpts(opts.logging)
  if (logging.agendas) {
    logAgendas(dispatcher)
  }

  function nextAgenda(agenda) {
    const obs = agenda
      .subscribeOn(scheduler)
      .publishReplay()
      .refCount()

    dispatcher.next(obs)
  }

  function reduce(fn, init) {
    if (typeof fn[identifier] === 'number') {
      return cache[fn[identifier]].store
    }

    // Generate cache index and set it on the reducer
    const index = cache.length
    fn[identifier] = index

    // Create cursor pointing to the state history
    let cursor = createState(fn, fn(init, KICKSTART_ACTION))

    // Describe states using the series of agendas
    const store = Observable.of(cursor.state)
      .concat(dispatcher
        .map(agenda => {
          // Reference agenda's root state
          const anchor = cursor

          // Collect agenda's actions
          const actions = []

          // Prepare agenda logger if necessary
          const logger = logging.stores ? logStore(fn.name || index, agenda) : null

          // Map Agenda to consecutive states and catch errors
          return agenda
            .filter(Boolean)
            .map(action => {
              cursor = cursor.doNext(action)
              actions.push(action)

              if (logger) {
                logger.change(action, cursor.state) // Logging new state by action
              }

              return cursor.state
            })
            .catch(err => {
              if (!logger) {
                console.error(err)
              }

              // Filter past actions by all of the failed agenda
              const previousState = cursor.state
              filterActions(anchor, x => actions.indexOf(x) === -1)

              if (logger) {
                logger.revert([ previousState, cursor.state ], err, actions) // Logging reversion
              }

              return Observable.of(cursor.state)
            })
            .distinctUntilChanged()
        })
        .mergeAll())
      .distinctUntilChanged()
      .publishReplay(1)

    const subscription = store.connect()

    // Cache the store
    cache.push({
      store,
      subscription
    })

    return store
  }


  // DEPRECATED: dispatch will soon be removed in favor of next
  function dispatch(action) {
    _dispatchNotice()
    assert(typeof action === 'function' || typeof action === 'object',
      'Expected a thunk, promise or action as argument.')

    if (isPromise(action)) {
      nextAgenda(Observable.fromPromise(action))
      return action
    }

    if (typeof action === 'function') {
      const res = action(x => {
        dispatcher.next(Observable.of(x))
      })

      return Promise.resolve(res)
    }

    dispatcher.next(Observable.of(action))
    return Promise.resolve(action)
  }

  // DEPRECATED: dispatch will soon be removed in favor of next
  function schedule(...agendas) {
    _scheduleNotice()
    assert(agendas.reduce((acc, obj) => acc && isObservable(obj), true),
      'Agendas can only be represented by Observables.')

    if (agendas.length === 1) {
      nextAgenda(agendas[0])
    } else if (agendas.length > 1) {
      nextAgenda(Observable.concat(...agendas))
    }
  }

  function next(arg) {
    if (isObservable(arg)) {
      nextAgenda(arg)
    } else if (isPromise(arg)) {
      nextAgenda(Observable.fromPromise(arg))
    } else if (typeof arg === 'function') {
      const res = arg(x => next(x), reduce)
      if (isObservable(res)) {
        nextAgenda(res)
      }
    } else {
      nextAgenda(Observable.of(arg))
    }
  }

  return Object.assign(Object.create(dispatcher), {
    next,
    dispatch,
    schedule,
    reduce,
    wrapActions(arg) {
      return wrapActions({ next }, arg)
    }
  })
}

