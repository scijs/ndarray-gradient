'use strict'

module.exports      = gradient

var dup             = require('dup')
var cwiseCompiler   = require('cwise-compiler')

var TEMPLATE_CACHE  = {}
var GRADIENT_CACHE  = {}

var EmptyProc = {
  body: "",
  args: [],
  thisVars: [],
  localVars: []
}

var centralDiff = cwiseCompiler({
  args: [ 'array', 'array', 'array' ],
  pre: EmptyProc,
  post: EmptyProc,
  body: {
    args: [ {
      name: 'out',
      lvalue: true,
      rvalue: false,
      count: 1
    }, {
      name: 'left',
      lvalue: false,
      rvalue: true,
      count: 1
    }, {
      name: 'right',
      lvalue: false,
      rvalue: true,
      count: 1
    }],
    body: "out=0.5*(left-right)",
    thisVars: [],
    localVars: []
  },
  funcName: 'cdiff'
})

var zeroOut = cwiseCompiler({
  args: [ 'array' ],
  pre: EmptyProc,
  post: EmptyProc,
  body: {
    args: [ {
      name: 'out',
      lvalue: true,
      rvalue: false,
      count: 1
    }],
    body: "out=0",
    thisVars: [],
    localVars: []
  },
  funcName: 'zero'
})

function generateTemplate(d) {
  if(d in TEMPLATE_CACHE) {
    return TEMPLATE_CACHE[d]
  }
  var code = []
  for(var i=0; i<d; ++i) {
    code.push('out', i, 's=0.5*(inp', i, 'l-inp', i, 'r);')
  }
  var args = [ 'array' ]
  var names = ['junk']
  for(var i=0; i<d; ++i) {
    args.push('array')
    names.push('out' + i + 's')
    var o = dup(d)
    o[i] = -1
    args.push({
      array: 0,
      offset: o.slice()
    })
    o[i] = 1
    args.push({
      array: 0,
      offset: o.slice()
    })
    names.push('inp' + i + 'l', 'inp' + i + 'r')
  }
  return TEMPLATE_CACHE[d] = cwiseCompiler({
    args: args,
    pre:  EmptyProc,
    post: EmptyProc,
    body: {
      body: code.join(''),
      args: names.map(function(n) {
        return {
          name: n,
          lvalue: n.indexOf('out') === 0,
          rvalue: n.indexOf('inp') === 0,
          count: (n!=='junk')|0
        }
      }),
      thisVars: [],
      localVars: []
    },
    funcName: 'fdTemplate' + d
  })
}

function generateGradient(boundaryConditions) {
  var token = boundaryConditions.join()
  var proc = GRADIENT_CACHE[token]
  if(proc) {
    return proc
  }

  var d = boundaryConditions.length
  var code = ['function gradient(dst,src){var s=src.shape.slice();' ]

  function handleBoundary(facet) {
    var cod = d - facet.length

    var loStr = []
    var hiStr = []
    var pickStr = []
    for(var i=0; i<d; ++i) {
      if(facet.indexOf(i+1) >= 0) {
        pickStr.push('0')
      } else if(facet.indexOf(-(i+1)) >= 0) {
        pickStr.push('s['+i+']-1')
      } else {
        pickStr.push('-1')
        loStr.push('1')
        hiStr.push('s['+i+']-2')
      }
    }
    var boundStr = '.lo(' + loStr.join() + ').hi(' + hiStr.join() + ')'
    if(loStr.length === 0) {
      boundStr = ''
    }

    if(cod > 0) {
      code.push('if(1')
      for(var i=0; i<d; ++i) {
        if(facet.indexOf(i+1) >= 0 || facet.indexOf(-(i+1)) >= 0) {
          continue
        }
        code.push('&&s[', i, ']>2')
      }
      code.push('){grad', cod, '(src.pick(', pickStr.join(), ')', boundStr)
      for(var i=0; i<d; ++i) {
        if(facet.indexOf(i+1) >= 0 || facet.indexOf(-(i+1)) >= 0) {
          continue
        }
        code.push(',dst.pick(', pickStr.join(), ',', i, ')', boundStr)
      }
      code.push(');')
    }

    for(var i=0; i<facet.length; ++i) {
      var bnd = Math.abs(facet[i])-1
      var outStr = 'dst.pick(' + pickStr.join() + ',' + bnd + ')' + boundStr
      switch(boundaryConditions[bnd]) {

        case 'clamp':
          var cPickStr = pickStr.slice()
          var dPickStr = pickStr.slice()
          if(facet[i] < 0) {
            cPickStr[bnd] = 's[' + bnd + ']-2'
          } else {
            dPickStr[bnd] = '1'
          }
          if(cod === 0) {
            code.push('if(s[', bnd, ']>1){dst.set(',
              pickStr.join(), ',', bnd, ',0.5*(src.get(',
                cPickStr.join(), ')-src.get(',
                dPickStr.join(), ')))}else{dst.set(',
              pickStr.join(), ',', bnd, ',0)};')
          } else {
            code.push('if(s[', bnd, ']>1){diff(', outStr,
                ',src.pick(', cPickStr.join(), ')', boundStr,
                ',src.pick(', dPickStr.join(), ')', boundStr,
                ');}else{zero(', outStr, ');};')
          }
        break

        case 'mirror':
          if(cod === 0) {
            code.push('dst.set(', pickStr.join(), ',', bnd, ',0);')
          } else {
            code.push('zero(', outStr, ');')
          }
        break

        case 'wrap':
          var aPickStr = pickStr.slice()
          var bPickStr = pickStr.slice()
          if(facet[i] < 0) {
            aPickStr[bnd] = 's[' + bnd + ']-2'
            bPickStr[bnd] = '0'

          } else {
            aPickStr[bnd] = 's[' + bnd + ']-1'
            bPickStr[bnd] = '1'
          }
          if(cod === 0) {
            code.push('if(s[', bnd, ']>2){dst.set(',
              pickStr.join(), ',', bnd, ',0.5*(src.get(',
                aPickStr.join(), ')-src.get(',
                bPickStr.join(), ')))}else{dst.set(',
              pickStr.join(), ',', bnd, ',0)};')
          } else {
            code.push('if(s[', bnd, ']>2){diff(', outStr,
                ',src.pick(', aPickStr.join(), ')', boundStr,
                ',src.pick(', bPickStr.join(), ')', boundStr,
                ');}else{zero(', outStr, ');};')
          }
        break

        default:
          throw new Error('ndarray-gradient: Invalid boundary condition')
      }
    }

    if(cod > 0) {
      code.push('};')
    }
  }

  //Enumerate ridges, facets, etc. of hypercube
  for(var i=0; i<(1<<d); ++i) {
    var faces = []
    for(var j=0; j<d; ++j) {
      if(i & (1<<j)) {
        faces.push(j+1)
      }
    }
    for(var k=0; k<(1<<faces.length); ++k) {
      var sfaces = faces.slice()
      for(var j=0; j<faces.length; ++j) {
        if(k & (1<<j)) {
          sfaces[j] = -sfaces[j]
        }
      }
      handleBoundary(sfaces)
    }
  }

  code.push('return dst;};return gradient')

  //Compile and link routine, save cached procedure
  var linkNames = [ 'diff', 'zero' ]
  var linkArgs  = [ centralDiff, zeroOut ]
  for(var i=1; i<=d; ++i) {
    linkNames.push('grad' + i)
    linkArgs.push(generateTemplate(i))
  }
  linkNames.push(code.join(''))

  var link = Function.apply(void 0, linkNames)
  var proc = link.apply(void 0, linkArgs)
  GRADIENT_CACHE[token] = proc
  return proc
}

function gradient(out, inp, bc) {
  if(Array.isArray(bc)) {
    if(bc.length !== inp.dimension) {
      throw new Error('ndarray-gradient: invalid boundary conditions')
    }
  } else if(typeof bc === 'string') {
    bc = dup(inp.dimension, bc)
  } else {
    bc = dup(inp.dimension, 'clamp')
  }
  if(out.dimension !== inp.dimension + 1) {
    throw new Error('ndarray-gradient: output dimension must be +1 input dimension')
  }
  if(out.shape[inp.dimension] !== inp.dimension) {
    throw new Error('ndarray-gradient: output shape must match input shape')
  }
  for(var i=0; i<inp.dimension; ++i) {
    if(out.shape[i] !== inp.shape[i]) {
      throw new Error('ndarray-gradient: shape mismatch')
    }
  }
  if(inp.size === 0) {
    return out
  }
  if(inp.dimension === 0) {
    out.set(0)
    return out
  }
  var cached = generateGradient(bc)
  return cached(out, inp)
}