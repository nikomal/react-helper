/**
 * cpopy https://github.com/tj/co/blob/717b043371ba057cb7a4a2a4e47120d598116ed7/index.js#L210
 */
import {
  takeLatest, put, fork, call
} from 'redux-saga/effects';

import isGeneratorFunction from './is-generator';
import { editInSaga } from '../actions';
import {
  pushRunningStack,
  popRunningStack,
} from '../mark-status';
import IOType, {
  anyOne,
  simpleBindResult,
} from './ios';
import {
  setValKeyPathMute,
} from '../util/obj_key_path_ops';

const cacheMap = new Map();

const noop = () => {};

export default function genSagas(obj, page, ctx) {
  function newInputFactory(fn) {
    return function newPut(action, description = '') {
      if (!action.type) {
        return put({
          type: editInSaga,
          page,
          fromMethod: fn.name,
          fn: action,
          description,
        });
      }
      return put(action);
    };
  }

  if (!cacheMap.get(page)) {
    const keys = Object.keys(obj);
    const result = {};
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (isGeneratorFunction(obj[key])) {
        result[`${page}/${key}`] = obj[key];
      }
    }
    if (Object.keys(result).length === 0) return null;
    cacheMap.set(page, function* generatedSaga() {
      const actionList = Object.keys(result);
      for (let i = 0; i < actionList.length; i += 1) {
        const key = actionList[i];
        const fn = result[key];
        yield takeLatest(key, function* takeLatestActionSaga(action) {
          const currentFrame = pushRunningStack();
          const newPutFn = newInputFactory(fn);
          const markings = [];
          try {
            const iterator = fn(action, ctx, newPutFn);
            let val = null;
            while (true) {
              const { done, value } = iterator.next(val);
              if (done) break;
              const added = [];
              while (currentFrame.length) {
                const statusVar = currentFrame.pop();
                markings.push(statusVar);
                added.push(statusVar);
              }
              if (added.length) {
                yield newPutFn((state) => {
                  added.forEach((mark) => {
                    state[mark] = 0;
                  });
                }, 'change some flags to loading');
              }
              popRunningStack();
              // @TODO experimental
              if (Object.hasOwnProperty.call(value, IOType) && value[IOType]) {
                if (value.type === simpleBindResult) {
                  const [promise, path] = value.args;
                  const promiseResult = yield promise;
                  yield newPutFn(state => setValKeyPathMute(state, path.split('.'), promiseResult));
                } else if (value.type === anyOne) {
                  let [promiseArray, anyoneCallback] = value.args;
                  if (!Array.isArray(promiseArray)) {
                    promiseArray = [promiseArray];
                  }
                  anyoneCallback = anyoneCallback || noop;
                  yield call(function* anyOneIOWrapper() {
                    for (let j = 0; j < promiseArray.length; j += 1) {
                      yield fork(anyoneCallback, promiseArray[j], j);
                    }
                    yield Promise.all(promiseArray);
                  });
                }
              } else {
                val = yield value;
              }
              pushRunningStack(currentFrame);
            }
            if (markings.length) {
              yield newPutFn((state) => {
                markings.forEach((mark) => {
                  state[mark] = 1;
                });
              }, 'change some flags to done');
            }
          } catch (e) {
            if (markings.length) {
              yield newPutFn((state) => {
                markings.forEach((mark) => {
                  state[mark] = 2;
                });
              }, 'change some flags to error');
            }
            throw e;
          } finally {
            popRunningStack();
          }
        });
      }
    });
  }
  return cacheMap.get(page);
}
