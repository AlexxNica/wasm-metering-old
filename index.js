/**
 *
 * Metering is done by summing the "contunois" subtrees of the AST
 * Countunous := no break or return conditions
 * if a break condition happens in a block then the block can be though of
 * as two sperate subtrees
 *
 * TODO
 * [] run test suite
 * [] add memory count
 *   [] define count func
 * [] add streaming
 *  [] have post-order binary encoding
 *    [] post oder parse specail tokens
 *       . LEAF
 *       . NODE
 *       . ROOT
 */
'use strict'
const parser = require('wast-parser')
const codegen = require('wast-codegen')
const AST = require('wast-graph')
const gasTable = require('./gastable.json')
let addGasIndex // a messy global

// adds the import statement for the Ethereum system module
// '(import "ethereum" "useGas" (param i32))'
function addImport (rootNode) {
  const json = {
    kind: 'import',
    modName: {
      kind: 'literal',
      value: 'ethereum'
    },
    funcName: {
      kind: 'literal',
      value: 'useGas'
    },
    type: null,
    params: [{
      kind: 'param',
      items: [{
        kind: 'item',
        type: 'i32'
      }]
    }]
  }

  // we are assuming the root node is "script"
  // find the `module`s and inject the import
  const body = rootNode.get('body')
  for (let item of body.edges) {
    if (item[1].kind === 'module') {
      item[1].get('body').push(json)
    }
  }
}

// adds a gas counting statement to a node
// (call_import <addGasindex> (i32.const <amount>))
function addGasCountBlock (amount, node, index) {
  const call_import = {
    kind: 'call_import',
    id: {
      kind: 'literal',
      value: addGasIndex,
      raw: addGasIndex
    },
    exprs: [{
      kind: 'const',
      type: 'i32',
      init: amount
    }]
  }
  const body = node.kind === 'array' ? node : node.get('body')
  body.insertAt(index, call_import)
}

// injects metering into an AST
function meteringTransform (vertex, startIndex) {
  if (startIndex === undefined) {
    startIndex = 0
  }
  // find the gas
  const result = calcGas(vertex, startIndex)
  if (result.gas) {
    // inject the metering statement
    addGasCountBlock(result.gas, vertex, startIndex)
  }
  return result
}

function getInstructionGas (vertex) {
  let kind = vertex.kind

  if (kind === 'binop' || kind === 'unop' || kind === 'relop') {
    if (vertex._value.type === 'f32' || vertex._value.type === 'f64') {
      throw new Error('Disallowed type: ' + vertex._value.type)
    }

    kind = vertex._value.type + '.' + vertex._value.operator
  }

  if (kind === 'cvtop') {
    if (vertex._value.type === 'f32' || vertex._value.type === 'f64' ||
       vertex._value.type1 === 'f32' || vertex._value.type1 === 'f64') {
      throw new Error('Disallowed type: ' + vertex._value.type)
    }

    kind = vertex._value.type + '.' + vertex._value.operator + '/' + vertex._value.type1
  }

  if (kind === 'store' || kind === 'load') {
    kind = vertex._value.type + '.' + vertex._value.kind
    if (vertex._value.size !== null) {
      // store8 needs special handling
      if (kind !== 'store' && vertex._value.size !== 8) {
        kind += vertex._value.size + (vertex._value.sign ? '_s' : '_u')
      }
    }
  }

  if (kind === 'const') {
    if (vertex._value.type === 'f32' || vertex._value.type === 'f64') {
      throw new Error('Disallowed type: ' + vertex._value.type)
    }

    kind = vertex._value.type + '.' + vertex._value.kind
  }

  if (gasTable[kind] === undefined) {
    throw new Error('Unsupported instruction: ' + kind)
  }

  return gasTable[kind]
}

// travers a subtree and counts
function calcGas (vertex, startIndex) {
  const kind = vertex.kind
  if (kind === 'loop') {
    let body = vertex.get('body')
    let hasBranch = meteringTransform(body).branchPoint
    return {
      branchPoint: hasBranch,
      gas: getInstructionGas(vertex)
    }
  } else if (kind === 'if') {
    // splits a if statement into two subtrees (then and else)
    let then = vertex.get('then')
    let els = vertex.get('else')
    let hasBranch = false
    if (then.kind !== 'then' && then.kind !== 'block') {
      // adds a `then` block that already exist implicitly
      const statement = then.copy()
      then = new AST('then')
      then.get('body').unshift(statement)
      vertex.set('then', then)
    } else if (els && els.kind !== 'else' && els.kind !== 'block') {
      // adds an `else` block that already exist implicitly
      const statement = els.copy()
      els = new AST('else')
      els.get('body').unshift(statement)
      vertex.set('else', els)
    }
    hasBranch = meteringTransform(then).branchPoint
    if (els) {
      hasBranch |= meteringTransform(els)
    }

    // calculates the gas for the test statement
    const result = calcGas(vertex.edges.get('test'), 0)
    result.gas += getInstructionGas(vertex)
    result.branchPoint = hasBranch
    return result
  } else {
    const retVal = {
      gas: getInstructionGas(vertex),
      branchPoint: vertex.isBranch
    }

    const edges = [...vertex.edges].slice(startIndex)
    // iterates the wasm statements and creates new sub-tree when branch
    // conditions are found
    for (const node of edges) {
      const result = calcGas(node[1], 0)
      retVal.branchPoint |= result.branchPoint
      retVal.gas += result.gas
      if (result.branchPoint && vertex.kind === 'array') {
        // found a new subtree
        meteringTransform(vertex, node[0] + 1)
        return retVal
      }
    }
    return retVal
  }
}

/**
 * Inject metering into wasm text
 * @param {sting} wast code in the wasm text format
 * @param {integer} spacing the number of spaces for the indentation
 */
module.exports.injectWAST = (wast, spacing) => {
  if (typeof wast !== 'string') {
    wast = wast.toString()
  }

  const astJSON = parser.parse(wast)
  const transformedJSON = injectJSON(astJSON)
  return codegen.generate(transformedJSON, spacing)
}

/**
 * Injects metering into the json ast
 * @param {object} json
 */
const injectJSON = module.exports.injectJSON = (json) => {
  const astGraph = new AST(json)
  addGasIndex = astGraph.importTable.length
  addImport(astGraph)
  // finds all the function in a module
  const funcs = astGraph.edges.get('body').edges.get(0).edges.get('body')
  for (const func of funcs.edges) {
    if (func[1].kind === 'func') {
      meteringTransform(func[1])
    }
  }
  return astGraph.toJSON()
}
