'use strict';

angular.module('ngTextcomplete', [])

/**
 * Utils.
 */
.factory('utils', [function() {
    /**
     * Exclusive execution control utility.
     */
    function lock(func) {
        var free, locked;
        free = function() {
            locked = false;
        };
        return function() {
            var args;
            if (locked) return;
            locked = true;
            args = toArray(arguments);
            args.unshift(free);
            func.apply(this, args);
        };
    };

    /**
     * Convert arguments into a real array.
     */
    function toArray(args) {
        return Array.prototype.slice.call(args);
    };

    /**
     * Bind the func to the context.
     */
    function bind(func, context) {
        // Use native Function#bind if it's available.
        return func.bind ? func.bind(context) : function() {
            func.apply(context, arguments)
        }
    };

    /**
     * Get the styles of any element from property names.
     */
    var getStyles = (function() {
        var color;
        color = $('<div></div>').css(['color']).color;
        if (typeof color !== 'undefined') {
            return function($el, properties) {
                return $el.css(properties);
            };
        } else { // for jQuery 1.8 or below
            return function($el, properties) {
                var styles;
                styles = {};
                angular.forEach(properties, function(property, i) {
                    styles[property] = $el.css(property);
                });
                return styles;
            };
        }
    })();

    /**
     * Memoize a search function.
     */
    function memoize(func) {
        var memo = {};
        return function(term, callback) {
            if (memo[term]) {
                callback(memo[term]);
            } else {
                func.call(this, term, function(data) {
                    memo[term] = (memo[term] || []).concat(data);
                    callback.apply(null, arguments);
                });
            }
        };
    };

    /**
     * Determine if the array contains a given value.
     */
    function include(array, value) {
        var i, l;
        if (array.indexOf) return array.indexOf(value) != -1;
        for (i = 0, l = array.length; i < l; i++) {
            if (array[i] === value) return true;
        }
        return false;
    };

    return {
        lock: lock,
        toArray: toArray,
        bind: bind,
        getStyles: getStyles,
        memoize: memoize,
        include: include
    }
}])

/**
 * Textarea manager class.
 */
.factory('Completer', ['ListView', 'utils', '$rootScope',
    function(ListView, utils, $rootScope) {
    var html, css, $baseWrapper, $baseList;
    html = {
        wrapper: '<div class="textcomplete-wrapper"></div>',
        list: '<ul class="dropdown-menu"></ul>'
    };
    css = {
        wrapper: {
            position: 'relative'
        },
        list: {
            position: 'absolute',
            top: 0,
            left: 0,
            zIndex: '100',
            display: 'none'
        }
    };
    $baseWrapper = $(html.wrapper).css(css.wrapper);
    $baseList = $(html.list).css(css.list);

    /**
     * Completer manager class.
     */
    function Completer($el, strategies) {
        var $wrapper, $list, focused;
        $list = $baseList.clone();
        this.el = $el.get(0); // textarea element
        this.$el = $el;
        $wrapper = _prepareWrapper(this.$el);
        // Refocus the textarea if it is being focused
        focused = this.el === document.activeElement;
        this.$el.wrap($wrapper).before($list);
        if (focused) {
            this.el.focus();
        }
        this.listView = new ListView($list, this);
        this.strategies = strategies;
        this.$el.on('keyup', utils.bind(this.onKeyup, this));
        this.$el.on('keydown', utils.bind(this.listView.onKeydown, this.listView));
        // Global click event handler
        $(document).on('click', utils.bind(function(e) {
            if (e.originalEvent && !e.originalEvent.keepTextCompleteDropdown) {
                this.listView.deactivate();
            }
        }, this));
    };

    /**
     * Completer's public methods
     */
    angular.extend(Completer.prototype, {
        /**
         * Show autocomplete list next to the caret.
         */
        renderList: function(data) {
            if (this.clearAtNext) {
                this.listView.clear();
                this.clearAtNext = false;
            }
            if (data.length) {
                if (!this.listView.shown) {
                    this.listView.setPosition(this.getCaretPosition()).clear().activate();
                    this.listView.strategy = this.strategy;
                }
                data = data.slice(0, this.strategy.maxCount);
                this.listView.render(data);
            }

            if (!this.listView.data.length && this.listView.shown) {
                this.listView.deactivate();
            }
        },
        searchCallbackFactory: function(free) {
            var self = this;
            return function(data, keep) {
                self.renderList(data);
                if (!keep) {
                    // This is the last callback for this search.
                    free();
                    self.clearAtNext = true;
                }
            };
        },
        /**
         * Keyup event handler.
         */
        onKeyup: function(e) {
            var searchQuery, term;
            searchQuery = this.extractSearchQuery(this.getTextFromHeadToCaret());
            if (searchQuery.length) {
                term = searchQuery[1];
                if (this.term === term) return; // Ignore shift-key or something.
                this.term = term;
                this.search(searchQuery);
            } else {
                this.term = null;
                this.listView.deactivate();
            }
        },
        onSelect: function(value, cb) {
            var pre, post, newSubStr;
            pre = this.getTextFromHeadToCaret();
            post = this.el.value.substring(this.el.selectionEnd);
            newSubStr = this.strategy.replace(value);
            if (angular.isArray(newSubStr)) {
                post = newSubStr[1] + post;
                newSubStr = newSubStr[0];
            }
            pre = pre.replace(this.strategy.match, newSubStr);
            this.$el.val(pre + post)

            /**
             * Here is the main difference from the original repo cause
             * once the user select the text, this result doesn't return
             * back to the `$scope` object in angularjs
             */
            $rootScope.$broadcast('onSelect', this.$el.val());
            $rootScope.$apply();

            this.el.focus();
            this.el.selectionStart = this.el.selectionEnd = pre.length;
        },

        // Helper methods
        // ==============

        /**
         * Returns caret's relative coordinates from textarea's left top corner.
         */
        getCaretPosition: function() {
            // Browser native API does not provide the way to know the position of
            // caret in pixels, so that here we use a kind of hack to accomplish
            // the aim. First of all it puts a div element and completely copies
            // the textarea's style to the element, then it inserts the text and a
            // span element into the textarea.
            // Consequently, the span element's position is the thing what we want.
            if (this.el.selectionEnd === 0) return;
            var properties, css, $div, $span, position;
            properties = ['border-width', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'height', 'letter-spacing', 'word-spacing', 'line-height', 'text-decoration', 'width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'];
            css = angular.extend({
                position: 'absolute',
                overflow: 'auto',
                'white-space': 'pre-wrap',
                top: 0,
                left: -9999
            }, utils.getStyles(this.$el, properties));
            $div = $('<div></div>').css(css).text(this.getTextFromHeadToCaret());
            $span = $('<span></span>').text('&nbsp;').appendTo($div);
            this.$el.before($div);
            position = $span.position();
            position.top += $span.height() - this.$el.scrollTop();

            $div.remove();
            return position;
        },
        getTextFromHeadToCaret: function() {
            var text, selectionEnd, range;
            selectionEnd = this.el.selectionEnd;
            if (typeof selectionEnd === 'number') {
                text = this.el.value.substring(0, selectionEnd);
            } else if (document.selection) {
                range = this.el.createTextRange();
                range.moveStart('character', 0);
                range.moveEnd('textedit');
                text = range.text;
            }
            return text;
        },
        /**
         * Parse the value of textarea and extract search query.
         */
        extractSearchQuery: function(text) {
            // If a search query found, it returns used strategy and the query
            // term. If the caret is currently in a code block or search query does
            // not found, it returns an empty array.
            var name, strategy, match;
            for (name in this.strategies)
            if (this.strategies.hasOwnProperty(name)) {
                strategy = this.strategies[name];
                match = text.match(strategy.match);
                if (match) {
                    return [strategy, match[strategy.index]];
                }
            }
            return [];
        },
        search: utils.lock(function(free, searchQuery) {
            var term, strategy;
            this.strategy = searchQuery[0];
            term = searchQuery[1];
            this.strategy.search(term, this.searchCallbackFactory(free));
        })
    });

    /**
     * Completer's private functions
     */
    function _prepareWrapper($el) {
        return $baseWrapper.css('display', $el.css('display'));
    };

    return Completer;
}])

/**
 * Dropdown menu manager class.
 */
.factory('ListView', ['utils', function(utils) {
    function ListView($el, completer) {
        this.$el = $el;
        this.index = 0;
        this.completer = completer;
        this.$el.on('click', 'li.textcomplete-item', utils.bind(this.onClick, this));
    }

    angular.extend(ListView.prototype, {
        shown: false,
        render: function(data) {
            var html, i, l, index, val;
            html = '';
            for (i = 0, l = data.length; i < l; i++) {
                val = data[i];
                if (utils.include(this.data, val)) continue;
                index = this.data.length;
                this.data.push(val);
                html += '<li class="textcomplete-item" data-index="' + index + '"><a>';
                html += this.strategy.template(val);
                html += '</a></li>';
                if (this.data.length === this.strategy.maxCount) break;
            }
            this.$el.append(html)
            if (!this.data.length) {
                this.deactivate();
            } else {
                this.activateIndexedItem();
            }
        },
        clear: function() {
            this.data = [];
            this.$el.html('');
            this.index = 0;
            return this;
        },
        activateIndexedItem: function() {
            var $item;
            this.$el.find('.active').removeClass('active');
            this.getActiveItem().addClass('active');
        },
        getActiveItem: function() {
            return $(this.$el.children().get(this.index));
        },
        activate: function() {
            if (!this.shown) {
                this.$el.show();
                this.shown = true;
            }
            return this;
        },
        deactivate: function() {
            if (this.shown) {
                this.$el.hide();
                this.shown = false;
                this.data = this.index = null;
            }
            return this;
        },
        setPosition: function(position) {
            this.$el.css(position);
            return this;
        },
        select: function(index) {
            this.completer.onSelect(this.data[index]);
            this.deactivate();
        },
        onKeydown: function(e) {
            var $item;
            if (!this.shown) return;
            if (e.keyCode === 27) { // ESC
                this.deactivate();
            } else if (e.keyCode === 38) { // UP
                e.preventDefault();
                if (this.index === 0) {
                    this.index = this.data.length - 1;
                } else {
                    this.index -= 1;
                }
                this.activateIndexedItem();
            } else if (e.keyCode === 40) { // DOWN
                e.preventDefault();
                if (this.index === this.data.length - 1) {
                    this.index = 0;
                } else {
                    this.index += 1;
                }
                this.activateIndexedItem();
            } else if (e.keyCode === 13 || e.keyCode === 9) { // ENTER or TAB
                e.preventDefault();
                this.select(parseInt(this.getActiveItem().data('index')));
            }
        },
        onClick: function(e) {
            var $e = $(e.target);
            e.originalEvent.keepTextCompleteDropdown = true;
            if (!$e.hasClass('textcomplete-item')) {
                $e = $e.parents('li.textcomplete-item');
            }
            this.select(parseInt($e.data('index')));
        }
    });

    return ListView;
}])

/**
 * Textcomplete class.
 */
.factory('Textcomplete', ['utils', 'Completer', function(utils, Completer) {
    /**
     * Default template function.
     */
    function identity(obj) {
        return obj;
    };

    /**
     * Textcomplete class
     * @param {[type]} ta         [description]
     * @param {[type]} strategies [description]
     */
    function Textcomplete(ta, strategies) {
        var name, strategy;
        for (name in strategies) {
            if (strategies.hasOwnProperty(name)) {
                strategy = strategies[name];
                if (!strategy.template) {
                    strategy.template = identity;
                }
                if (strategy.index == null) {
                    strategy.index = 2;
                }
                if (strategy.cache) {
                    strategy.search = utils.memoize(strategy.search);
                }
                strategy.maxCount = strategy.maxCount || 10;
            }
        }
        return new Completer(ta, strategies);
    };

    return Textcomplete;
}])

;